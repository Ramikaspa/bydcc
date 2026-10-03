import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = join(__dirname, "..", "data", "byd-ocpp.sqlite");

function now() {
  return new Date().toISOString();
}

function plain(row) {
  return row ? { ...row } : null;
}

function plains(rows) {
  return rows.map((r) => ({ ...r }));
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chargers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  charge_point_id TEXT NOT NULL UNIQUE,
  ocpp_url TEXT NOT NULL DEFAULT '',
  protocol TEXT NOT NULL DEFAULT '1.6J',
  start_mode TEXT NOT NULL DEFAULT 'rfid',
  soc_start REAL NOT NULL DEFAULT 30,
  connector_id INTEGER NOT NULL DEFAULT 1,
  heartbeat_interval INTEGER NOT NULL DEFAULT 30,
  meter_interval INTEGER NOT NULL DEFAULT 10,
  max_power INTEGER NOT NULL DEFAULT 120000,
  max_current INTEGER NOT NULL DEFAULT 250,
  language TEXT NOT NULL DEFAULT 'en',
  brightness INTEGER NOT NULL DEFAULT 90,
  id_tag TEXT NOT NULL DEFAULT 'BYD-RFID-001',
  serial_number TEXT,
  firmware_version TEXT DEFAULT 'V2.3.14-BYD',
  vendor TEXT DEFAULT 'BYD',
  model TEXT DEFAULT 'BYD EV Charger 120kW',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS variables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  charger_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(charger_id, key)
);
CREATE TABLE IF NOT EXISTS samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  charger_id INTEGER NOT NULL,
  ts TEXT NOT NULL,
  soc REAL,
  power REAL,
  current REAL,
  voltage REAL,
  energy_wh REAL,
  board_temp REAL,
  connector_temp REAL,
  frequency REAL,
  power_factor REAL,
  phase TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  charger_id INTEGER NOT NULL,
  transaction_id INTEGER,
  id_tag TEXT,
  started_at TEXT,
  stopped_at TEXT,
  meter_start INTEGER,
  meter_stop INTEGER,
  reason TEXT,
  soc_start REAL,
  soc_stop REAL
);
CREATE TABLE IF NOT EXISTS ocpp_frames (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  charger_id INTEGER,
  charge_point_id TEXT,
  direction TEXT,
  ts TEXT NOT NULL,
  frame TEXT NOT NULL
);
`;

const DEFAULTS = {
  ocpp_url: "",
  protocol: "1.6J",
  start_mode: "rfid",
  soc_start: 30,
  connector_id: 1,
  heartbeat_interval: 30,
  meter_interval: 10,
  max_power: 120000,
  max_current: 250,
  language: "en",
  brightness: 90,
  id_tag: "BYD-RFID-001",
  firmware_version: "V2.3.14-BYD",
  vendor: "BYD",
  model: "BYD EV Charger 120kW",
};

export function openStore(dbPath) {
  const path = dbPath ?? process.env.OCPP_DB ?? DEFAULT_FILE;
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  const store = {
    path,
    db,
    close: () => db.close(),

    listChargers() {
      return plains(db.prepare("SELECT * FROM chargers ORDER BY id").all());
    },

    getCharger(id) {
      return plain(db.prepare("SELECT * FROM chargers WHERE id = ?").get(Number(id)));
    },

    getChargerByCpId(cpId) {
      return plain(db.prepare("SELECT * FROM chargers WHERE charge_point_id = ?").get(String(cpId)));
    },

    seedDefault() {
      if (this.listChargers().length) return this.listChargers()[0];
      return this.createCharger({ charge_point_id: "BYD-001" });
    },

    createCharger(input = {}) {
      const ts = now();
      const charge_point_id = String(input.charge_point_id || input.chargePointId || `BYD-${String(Date.now()).slice(-6)}`);
      const row = { ...DEFAULTS, ...snake(input), charge_point_id, created_at: ts, updated_at: ts };
      let r;
      try {
        r = db.prepare(`
        INSERT INTO chargers (
          charge_point_id, ocpp_url, protocol, start_mode, soc_start, connector_id,
          heartbeat_interval, meter_interval, max_power, max_current, language, brightness,
          id_tag, serial_number, firmware_version, vendor, model, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
          row.charge_point_id, row.ocpp_url ?? "", row.protocol, row.start_mode, row.soc_start,
          row.connector_id, row.heartbeat_interval, row.meter_interval, row.max_power, row.max_current,
          row.language, row.brightness, row.id_tag, row.serial_number ?? null, row.firmware_version,
          row.vendor, row.model, row.created_at, row.updated_at,
        );
      } catch (err) {
        if (String(err.message).includes("UNIQUE")) {
          throw new Error(`Charge point id already exists: ${charge_point_id}`);
        }
        throw err;
      }
      const created = this.getCharger(r.lastInsertRowid);
      this.setVariables(created.id, {
        status: "Unavailable",
        connected: false,
        soc: created.soc_start,
      });
      return created;
    },

    updateCharger(id, patch) {
      const cur = this.getCharger(id);
      if (!cur) throw new Error("charger not found");
      const mapped = snake(patch);
      const row = { ...cur };
      for (const [k, v] of Object.entries(mapped)) {
        if (!(k in cur)) continue;
        if (v === "" && k !== "ocpp_url") continue;
        row[k] = v;
      }
      row.updated_at = now();
      db.prepare(`
        UPDATE chargers SET
          charge_point_id=?, ocpp_url=?, protocol=?, start_mode=?, soc_start=?, connector_id=?,
          heartbeat_interval=?, meter_interval=?, max_power=?, max_current=?, language=?, brightness=?,
          id_tag=?, serial_number=?, firmware_version=?, vendor=?, model=?, updated_at=?
        WHERE id=?
      `).run(
        row.charge_point_id, row.ocpp_url, row.protocol, row.start_mode, row.soc_start, row.connector_id,
        row.heartbeat_interval, row.meter_interval, row.max_power, row.max_current, row.language, row.brightness,
        row.id_tag, row.serial_number, row.firmware_version, row.vendor, row.model, row.updated_at, row.id,
      );
      return this.getCharger(id);
    },

    deleteCharger(id) {
      db.prepare("DELETE FROM variables WHERE charger_id = ?").run(Number(id));
      db.prepare("DELETE FROM samples WHERE charger_id = ?").run(Number(id));
      db.prepare("DELETE FROM sessions WHERE charger_id = ?").run(Number(id));
      db.prepare("DELETE FROM ocpp_frames WHERE charger_id = ?").run(Number(id));
      db.prepare("DELETE FROM chargers WHERE id = ?").run(Number(id));
    },

    setVariables(chargerId, vars) {
      const ts = now();
      const stmt = db.prepare(`
        INSERT INTO variables (charger_id, key, value, updated_at) VALUES (?,?,?,?)
        ON CONFLICT(charger_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
      `);
      for (const [key, value] of Object.entries(vars)) {
        if (value === undefined) continue;
        stmt.run(Number(chargerId), String(key), stringify(value), ts);
      }
    },

    getVariables(chargerId) {
      const rows = plains(db.prepare("SELECT key, value, updated_at FROM variables WHERE charger_id = ?").all(Number(chargerId)));
      const out = {};
      for (const r of rows) out[r.key] = parse(r.value);
      return out;
    },

    insertSample(chargerId, sample) {
      if (!sample) return;
      db.prepare(`
        INSERT INTO samples (charger_id, ts, soc, power, current, voltage, energy_wh, board_temp, connector_temp, frequency, power_factor, phase)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        Number(chargerId), now(), sample.soc ?? null, sample.power ?? null, sample.current ?? null,
        sample.voltage ?? null, sample.energyWh ?? null, sample.boardTemp ?? null, sample.connectorTemp ?? null,
        sample.frequency ?? null, sample.powerFactor ?? null, sample.phase ?? null,
      );
    },

    startSession(chargerId, data) {
      const r = db.prepare(`
        INSERT INTO sessions (charger_id, transaction_id, id_tag, started_at, meter_start, soc_start)
        VALUES (?,?,?,?,?,?)
      `).run(Number(chargerId), data.transactionId ?? null, data.idTag ?? null, now(), data.meterStart ?? null, data.socStart ?? null);
      return Number(r.lastInsertRowid);
    },

    endSession(sessionId, data) {
      db.prepare(`
        UPDATE sessions SET stopped_at=?, transaction_id=?, meter_stop=?, reason=?, soc_stop=? WHERE id=?
      `).run(now(), data.transactionId ?? null, data.meterStop ?? null, data.reason ?? null, data.socStop ?? null, Number(sessionId));
    },

    insertFrame(chargerId, chargePointId, direction, frame) {
      db.prepare(`
        INSERT INTO ocpp_frames (charger_id, charge_point_id, direction, ts, frame) VALUES (?,?,?,?,?)
      `).run(chargerId ?? null, chargePointId ?? null, direction, now(), typeof frame === "string" ? frame : JSON.stringify(frame));
      if (chargerId != null) {
        const kept = db.prepare(
          "SELECT id FROM ocpp_frames WHERE charger_id = ? ORDER BY id DESC LIMIT 1 OFFSET 199",
        ).get(Number(chargerId));
        if (kept) {
          db.prepare("DELETE FROM ocpp_frames WHERE charger_id = ? AND id < ?").run(Number(chargerId), kept.id);
        }
      }
    },

    recentFrames(chargerId, limit = 40) {
      return plains(db.prepare(`
        SELECT direction, ts, frame FROM ocpp_frames WHERE charger_id = ? ORDER BY id DESC LIMIT ?
      `).all(Number(chargerId), limit)).reverse();
    },
  };
  return store;
}

function stringify(v) {
  return typeof v === "string" ? v : JSON.stringify(v);
}

function parse(v) {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function snake(input) {
  const map = {
    chargePointId: "charge_point_id",
    ocppUrl: "ocpp_url",
    startMode: "start_mode",
    socStart: "soc_start",
    connectorId: "connector_id",
    heartbeatInterval: "heartbeat_interval",
    meterValueSampleInterval: "meter_interval",
    meterInterval: "meter_interval",
    maxPower: "max_power",
    maxCurrent: "max_current",
    idTag: "id_tag",
    serialNumber: "serial_number",
    firmwareVersion: "firmware_version",
  };
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    out[map[k] ?? k] = v;
  }
  return out;
}

export function chargerToSettings(row) {
  if (!row) return null;
  return {
    chargerId: row.id,
    chargePointId: row.charge_point_id,
    ocppUrl: row.ocpp_url,
    protocol: row.protocol,
    startMode: row.start_mode,
    socStart: row.soc_start,
    connectorId: row.connector_id,
    heartbeatInterval: row.heartbeat_interval,
    meterValueSampleInterval: row.meter_interval,
    maxPower: row.max_power,
    maxCurrent: row.max_current,
    language: row.language,
    brightness: row.brightness,
    idTag: row.id_tag,
    serialNumber: row.serial_number,
    firmwareVersion: row.firmware_version,
    vendor: row.vendor,
    model: row.model,
  };
}

export { DEFAULT_FILE };
