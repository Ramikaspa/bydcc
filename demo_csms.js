#!/usr/bin/env node
/**
 * Local OCPP 1.6J Central System + charger HMI (not a mock protocol).
 * Screen:   http://127.0.0.1:18473/?id=<n>
 * Settings: http://127.0.0.1:18473/settings?id=<n>
 * Fleet:    http://127.0.0.1:18473/fleet
 * OCPP WS:  ws://127.0.0.1:18473/ocpp/<ChargePointId>
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { BydOcppSimulator, loadProfile } from "./byd_charger_simulator.js";
import {
  CALL,
  CALLRESULT,
  CALLERROR,
} from "./ocpp_json_client.js";
import {
  OcppSchemaError,
  compact,
  validateCallFromCp,
  validateCallFromCsms,
  validateCallResultToCp,
} from "./ocpp16/schema.js";
import { openStore, chargerToSettings } from "./store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");
const HOST = process.env.CSMS_HOST ?? "0.0.0.0";
const PORT = Number(process.env.PORT ?? process.env.CSMS_PORT ?? 18473);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

let nextTx = 1000;
const sseClients = new Set();
const stations = new Map();
const runtimes = new Map();
let store = null;
let httpServerRef = null;

function chargerRow(id) {
  if (id != null && Number.isFinite(Number(id)) && store) {
    const row = store.getCharger(id);
    if (row) return row;
    throw new Error("charger not found");
  }
  return store?.seedDefault() ?? null;
}

function runtime(id) {
  const row = chargerRow(id);
  if (!row) return null;
  if (!runtimes.has(row.id)) {
    runtimes.set(row.id, {
      sim: null,
      plugged: { 1: false, 2: false },
      sessionMeterStart: null,
      sessionStartedAt: null,
      sessionDbId: null,
      frames: [],
      lock: Promise.resolve(),
    });
  }
  return { row, rt: runtimes.get(row.id) };
}

function snapshot(id) {
  const ctx = runtime(id);
  const row = ctx?.row;
  const rt = ctx?.rt;
  const sim = rt?.sim;
  const settings = chargerToSettings(row) ?? {};
  const sample = sim?.sample ?? null;
  const energyWh = sample?.energyWh ?? sim?.meterWh ?? null;
  const sessionKwh = rt?.sessionMeterStart != null && energyWh != null
    ? Math.max(0, (energyWh - rt.sessionMeterStart) / 1000)
    : 0;
  const frameLines = rt?.frames ?? [];
  return {
    chargerId: row?.id ?? null,
    connected: Boolean(sim?.client?.connected),
    status: sim?.status ?? "Unavailable",
    identity: sim ? sim.identity() : (row ? {
      vendor: row.vendor,
      model: row.model,
      serialNumber: row.serial_number,
      firmwareVersion: row.firmware_version,
    } : null),
    sample,
    transactionId: sim?.transactionId ?? null,
    connectorId: sim?.connectorId ?? settings.connectorId,
    plugged: { ...(rt?.plugged ?? { 1: false, 2: false }) },
    settings,
    session: {
      kwh: sessionKwh,
      startedAt: rt?.sessionStartedAt ?? null,
      idTag: sim?.idTag ?? null,
    },
    frames: frameLines.slice(-40),
    fleet: (store?.listChargers() ?? []).map((c) => ({
      id: c.id,
      chargePointId: c.charge_point_id,
      connected: Boolean(runtimes.get(c.id)?.sim?.client?.connected),
      status: runtimes.get(c.id)?.sim?.status ?? "Offline",
    })),
    variables: row ? store.getVariables(row.id) : {},
  };
}

function persistRuntime(id) {
  const ctx = runtime(id);
  if (!ctx || !store) return;
  const { row, rt } = ctx;
  const sim = rt.sim;
  const vars = {
    status: sim?.status ?? "Unavailable",
    connected: Boolean(sim?.client?.connected),
    soc: sim?.soc ?? row.soc_start,
    meterWh: sim?.meterWh ?? null,
    transactionId: sim?.transactionId ?? null,
    connectorId: sim?.connectorId ?? row.connector_id,
    power: sim?.sample?.power ?? null,
    current: sim?.sample?.current ?? null,
    voltage: sim?.sample?.voltage ?? null,
    startMode: sim?.startMode ?? row.start_mode,
    heartbeatInterval: sim?.heartbeatInterval ?? row.heartbeat_interval,
    meterInterval: sim?.meterInterval ?? row.meter_interval,
  };
  store.setVariables(row.id, vars);
  if (sim?.sample) store.insertSample(row.id, sim.sample);
}

function broadcast() {
  for (const res of sseClients) {
    try {
      res.write(`data: ${JSON.stringify(snapshot(res.chargerId))}\n\n`);
    } catch {
      sseClients.delete(res);
    }
  }
}

function logFrame(dir, cp, frame) {
  const line = `${dir} ${cp} ${JSON.stringify(frame)}`;
  console.log(`[CSMS ${dir} ${cp}] ${JSON.stringify(frame)}`);
  const row = store?.getChargerByCpId(cp);
  if (row) {
    const ctx = runtime(row.id);
    ctx.rt.frames.push(line);
    if (ctx.rt.frames.length > 80) ctx.rt.frames.shift();
    store.insertFrame(row.id, cp, dir, frame);
  }
  broadcast();
}

function handleCall(action, payload) {
  switch (action) {
    case "BootNotification":
      return {
        status: "Accepted",
        currentTime: new Date().toISOString(),
        interval: Number(chargerRow()?.heartbeat_interval ?? 30),
      };
    case "Heartbeat":
      return { currentTime: new Date().toISOString() };
    case "Authorize":
      return { idTagInfo: { status: "Accepted" } };
    case "StartTransaction": {
      const transactionId = nextTx++;
      return { transactionId, idTagInfo: { status: "Accepted" } };
    }
    case "StopTransaction":
      return { idTagInfo: { status: "Accepted" } };
    case "StatusNotification":
    case "MeterValues":
    case "DiagnosticsStatusNotification":
    case "FirmwareStatusNotification":
      return {};
    case "DataTransfer":
      return { status: "Accepted" };
    default:
      throw new OcppSchemaError("NotImplemented", action);
  }
}

function sendCallError(ws, uniqueId, err) {
  const code = err.ocppErrorCode ?? "FormationViolation";
  const frame = [CALLERROR, uniqueId, code, err.message ?? "", compact(err.errorDetails ?? {})];
  ws.send(JSON.stringify(frame));
  return frame;
}

export function csmsCall(chargePointId, action, payload = {}, timeoutMs = 15000) {
  const id = chargePointId || chargerRow()?.charge_point_id;
  const st = stations.get(id);
  if (!st?.ws) return Promise.reject(new Error(`Charge point ${id} is not connected`));
  const body = validateCallFromCsms(action, compact(payload));
  const uniqueId = randomUUID();
  const frame = [CALL, uniqueId, action, body];
  logFrame("→", id, frame);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      st.pending.delete(uniqueId);
      reject(new Error(`Timeout ${action}`));
    }, timeoutMs);
    st.pending.set(uniqueId, { resolve, reject, timer, action });
    st.ws.send(JSON.stringify(frame), (err) => {
      if (err) {
        clearTimeout(timer);
        st.pending.delete(uniqueId);
        reject(err);
      }
    });
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

async function serveStatic(req, res) {
  let path = req.url.split("?")[0];
  if (path === "/") path = "/index.html";
  if (path === "/settings") path = "/settings.html";
  if (path === "/fleet") path = "/fleet.html";
  if (path.includes("..")) {
    res.writeHead(400);
    res.end("bad path");
    return;
  }
  try {
    const file = join(PUBLIC_DIR, path);
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

function localWsUrl(httpServer) {
  const addr = httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : PORT;
  return `ws://127.0.0.1:${port}/ocpp`;
}

function resolveOcppUrl(httpServer, requested) {
  const local = localWsUrl(httpServer);
  if (!requested) return local;
  try {
    const u = new URL(requested);
    const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost";
    if (loopback) return local;
    return requested;
  } catch {
    return local;
  }
}

function applyProfileFromRow(profile, row) {
  profile.heartbeatInterval = Number(row.heartbeat_interval) || 30;
  profile.meterValueSampleInterval = Number(row.meter_interval) || 10;
  profile.maxPower = Number(row.max_power) || 120000;
  profile.maxCurrent = Number(row.max_current) || 250;
  profile.chargePointModel = row.model;
  profile.vendor = row.vendor;
  profile.firmwareVersion = row.firmware_version;
  return profile;
}

async function connectSim(httpServer, body = {}, { force = false } = {}) {
  const ctx = runtime(body.chargerId);
  const { row, rt } = ctx;
  const run = rt.lock.then(() => connectSimUnlocked(httpServer, body, { force }));
  rt.lock = run.catch(() => {});
  return run;
}

async function connectSimUnlocked(httpServer, body = {}, { force = false } = {}) {
  const ctx = runtime(body.chargerId);
  const { row, rt } = ctx;
  if (body.ocppUrl != null) store.updateCharger(row.id, { ocppUrl: body.ocppUrl });
  const fresh = chargerRow(row.id);
  if (rt.sim?.client?.connected && !force) return snapshot(fresh.id);
  if (rt.sim) {
    try { rt.sim.disconnect(); } catch { /* ignore */ }
    rt.sim = null;
  }
  const profile = applyProfileFromRow(loadProfile(), fresh);
  rt.sim = new BydOcppSimulator({
    protocol: fresh.protocol,
    profile,
    startMode: fresh.start_mode,
    serialNumber: fresh.serial_number || undefined,
  });
  rt.sim.meterInterval = profile.meterValueSampleInterval;
  rt.sim.heartbeatInterval = profile.heartbeatInterval;
  const url = resolveOcppUrl(httpServer, fresh.ocpp_url || body.url);
  await rt.sim.connect(url, fresh.charge_point_id, fresh.connector_id);
  rt.sim.soc = fresh.soc_start;
  const idn = rt.sim.identity();
  store.updateCharger(fresh.id, { serialNumber: idn.serialNumber, firmwareVersion: idn.firmwareVersion });
  persistRuntime(fresh.id);
  broadcast();
  return snapshot(fresh.id);
}

async function startCharge(httpServer, body = {}) {
  const ctx = runtime(body.chargerId);
  const { row, rt } = ctx;
  if (!rt.sim?.client?.connected) await connectSim(httpServer, body);
  if (rt.sim.status === "Charging") return snapshot(row.id);
  if (body.startMode) {
    store.updateCharger(row.id, { startMode: body.startMode });
    rt.sim.startMode = body.startMode;
  }
  const connectorId = Number(body.connectorId ?? row.connector_id);
  rt.sim.connectorId = connectorId;
  rt.plugged[connectorId] = true;
  const soc = body.soc ?? row.soc_start;
  const idTag = body.idTag || row.id_tag;
  rt.sessionMeterStart = rt.sim.meterWh;
  rt.sessionStartedAt = Date.now();
  await rt.sim.startCharging(idTag, soc);
  rt.sessionDbId = store.startSession(row.id, {
    transactionId: rt.sim.transactionId,
    idTag,
    meterStart: rt.sessionMeterStart,
    socStart: soc,
  });
  persistRuntime(row.id);
  broadcast();
  return snapshot(row.id);
}

async function stopCharge(body = {}) {
  const ctx = runtime(body.chargerId);
  const { row, rt } = ctx;
  const tx = rt.sim?.transactionId;
  const meterStop = rt.sim ? Math.round(rt.sim.meterWh) : null;
  const socStop = rt.sim?.soc;
  if (rt.sim) await rt.sim.stopCharging("Local");
  if (rt.sessionDbId) {
    store.endSession(rt.sessionDbId, { transactionId: tx, meterStop, reason: "Local", socStop });
    rt.sessionDbId = null;
  }
  rt.sessionMeterStart = null;
  rt.sessionStartedAt = null;
  rt.plugged[1] = false;
  rt.plugged[2] = false;
  persistRuntime(row.id);
  broadcast();
  return snapshot(row.id);
}

async function plugConnector(body) {
  const ctx = runtime(body.chargerId);
  const { row, rt } = ctx;
  const id = Number(body.connectorId ?? 1);
  rt.plugged[id] = body.plugged !== false;
  store.updateCharger(row.id, { connectorId: id });
  if (rt.sim && rt.sim.status === "Available" && rt.plugged[id]) {
    await rt.sim._notifyStatus(id, "Preparing");
    rt.sim.status = "Preparing";
  }
  if (rt.sim && !rt.plugged[id] && rt.sim.status === "Preparing") {
    await rt.sim._notifyStatus(id, "Available");
    rt.sim.status = "Available";
  }
  persistRuntime(row.id);
  broadcast();
  return snapshot(row.id);
}

function saveSettings(body) {
  const ctx = runtime(body.chargerId);
  const { row, rt } = ctx;
  const updated = store.updateCharger(row.id, body);
  if (rt.sim) {
    rt.sim.startMode = updated.start_mode;
    rt.sim.heartbeatInterval = Number(updated.heartbeat_interval) || 30;
    rt.sim.meterInterval = Number(updated.meter_interval) || 10;
    if (rt.sim.profile) applyProfileFromRow(rt.sim.profile, updated);
    rt.sim.config.HeartbeatInterval = String(updated.heartbeat_interval);
    rt.sim.config.MeterValueSampleInterval = String(updated.meter_interval);
    rt.sim._armHeartbeat?.();
  }
  persistRuntime(updated.id);
  broadcast();
  return snapshot(updated.id);
}

function qid(req, body = {}) {
  try {
    const u = new URL(req.url, "http://127.0.0.1");
    const q = u.searchParams.get("id") || u.searchParams.get("chargerId");
    if (q != null && Number.isFinite(Number(q))) return Number(q);
  } catch {
    /* ignore */
  }
  if (body.chargerId != null && Number.isFinite(Number(body.chargerId))) {
    return Number(body.chargerId);
  }
  return chargerRow()?.id;
}

async function handleHttp(req, res, httpServer) {
  const url = req.url.split("?")[0];
  if (req.method === "GET" && url === "/api/state") {
    sendJson(res, 200, snapshot(qid(req)));
    return;
  }
  if (req.method === "GET" && url === "/api/chargers") {
    sendJson(res, 200, { chargers: snapshot().fleet, rows: store.listChargers() });
    return;
  }
  if (req.method === "GET" && url === "/api/variables") {
    const id = qid(req);
    const row = store.getCharger(id);
    sendJson(res, 200, { charger: row, variables: store.getVariables(id), settings: chargerToSettings(row) });
    return;
  }
  if (req.method === "GET" && url === "/api/events") {
    res.chargerId = qid(req);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify(snapshot(res.chargerId))}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }
  if (req.method === "POST" && url === "/api/chargers") {
    try {
      const body = await readJson(req);
      const row = store.createCharger(body);
      sendJson(res, 201, { charger: row, settings: chargerToSettings(row) });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }
  const chargerMatch = url.match(/^\/api\/chargers\/(\d+)$/);
  if (chargerMatch && req.method === "POST") {
    try {
      const body = await readJson(req);
      const row = store.updateCharger(chargerMatch[1], body);
      sendJson(res, 200, { charger: row, settings: chargerToSettings(row) });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }
  if (chargerMatch && req.method === "DELETE") {
    const id = Number(chargerMatch[1]);
    const rt = runtimes.get(id);
    if (rt?.sim) {
      try { rt.sim.disconnect(); } catch { /* ignore */ }
    }
    runtimes.delete(id);
    store.deleteCharger(id);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "POST" && url === "/api/connect") {
    try {
      const body = await readJson(req);
      body.chargerId = qid(req, body);
      sendJson(res, 200, await connectSim(httpServer, body, { force: Boolean(body.force) }));
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }
  if (req.method === "POST" && url === "/api/start") {
    try {
      const body = await readJson(req);
      body.chargerId = qid(req, body);
      sendJson(res, 200, await startCharge(httpServer, body));
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }
  if (req.method === "POST" && url === "/api/stop") {
    try {
      const body = await readJson(req);
      body.chargerId = qid(req, body);
      sendJson(res, 200, await stopCharge(body));
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }
  if (req.method === "POST" && url === "/api/plug") {
    try {
      const body = await readJson(req);
      body.chargerId = qid(req, body);
      sendJson(res, 200, await plugConnector(body));
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }
  if (req.method === "POST" && url === "/api/settings") {
    try {
      const body = await readJson(req);
      body.chargerId = qid(req, body);
      saveSettings(body);
      if (body.reboot) {
        await connectSim(httpServer, body, { force: true });
      }
      sendJson(res, 200, snapshot(body.chargerId));
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }
  if (req.method === "POST" && url === "/api/csms/call") {
    try {
      const body = await readJson(req);
      const row = chargerRow(qid(req, body));
      const result = await csmsCall(body.chargePointId || row?.charge_point_id, body.action, body.payload ?? {});
      sendJson(res, 200, { result });
    } catch (err) {
      sendJson(res, 400, { error: err.message, ocppErrorCode: err.ocppErrorCode });
    }
    return;
  }
  if (req.method === "GET") {
    await serveStatic(req, res);
    return;
  }
  res.writeHead(405);
  res.end("method not allowed");
}

export function startDemoCsms({ host = HOST, port = PORT, autoBoot = false, dbPath } = {}) {
  stations.clear();
  runtimes.clear();
  store = openStore(dbPath ?? (autoBoot ? undefined : ":memory:"));
  store.seedDefault();
  const httpServer = createServer((req, res) => {
    handleHttp(req, res, httpServer).catch((err) => {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
    });
  });
  const wss = new WebSocketServer({
    server: httpServer,
    handleProtocols: (protocols) => {
      const list = [...protocols];
      if (list.includes("ocpp1.6")) return "ocpp1.6";
      if (list.includes("ocpp2.0.1")) return "ocpp2.0.1";
      return false;
    },
  });

  wss.on("connection", (ws, req) => {
    const path = req.url ?? "/";
    const parts = path.split("/").filter(Boolean);
    const chargePointId = parts[parts.length - 1] || "unknown";
    const st = { ws, pending: new Map() };
    stations.set(chargePointId, st);
    console.log(`[CSMS] ${chargePointId} connected ${path} proto=${ws.protocol}`);
    broadcast();

    ws.on("message", (data) => {
      let frame;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        console.error("[CSMS] bad JSON");
        return;
      }
      logFrame("←", chargePointId, frame);
      if (!Array.isArray(frame) || frame.length < 2) return;
      const type = frame[0];
      const uniqueId = String(frame[1]);

      if (type === CALLRESULT || type === CALLERROR) {
        const pending = st.pending.get(uniqueId);
        if (!pending) return;
        st.pending.delete(uniqueId);
        clearTimeout(pending.timer);
        if (type === CALLERROR) {
          const err = new Error(frame[3] || frame[2]);
          err.ocppErrorCode = frame[2];
          pending.reject(err);
        } else {
          pending.resolve(frame[2] ?? {});
        }
        return;
      }

      if (type !== CALL) return;
      const action = frame[2];
      try {
        const payload = validateCallFromCp(action, frame[3] ?? {});
        const raw = handleCall(action, payload);
        const result = validateCallResultToCp(action, compact(raw));
        const out = [CALLRESULT, uniqueId, result];
        logFrame("→", chargePointId, out);
        ws.send(JSON.stringify(out));
      } catch (err) {
        const out = sendCallError(ws, uniqueId, err);
        logFrame("→", chargePointId, out);
      }
    });

    ws.on("close", () => {
      stations.delete(chargePointId);
      console.log(`[CSMS] ${chargePointId} disconnected`);
      broadcast();
    });
  });

  const persistTick = setInterval(() => {
    for (const id of runtimes.keys()) persistRuntime(id);
  }, 2000);
  persistTick.unref?.();

  const tick = setInterval(() => broadcast(), 500);
  tick.unref?.();

  return new Promise((resolve) => {
    httpServer.listen(port, host, () => {
      const addr = httpServer.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : port;
      const url = `ws://127.0.0.1:${boundPort}/ocpp`;
      console.log(`[HMI] charger screen  http://127.0.0.1:${boundPort}/`);
      console.log(`[HMI] charger settings http://127.0.0.1:${boundPort}/settings`);
      console.log(`[HMI] fleet            http://127.0.0.1:${boundPort}/fleet`);
      console.log(`[CSMS] listening ${url}/<ChargePointId>`);
      console.log(`[DB] ${store.path}`);
      const ready = {
        httpServer,
        wss,
        url,
        host,
        port: boundPort,
        csmsCall,
        store,
        close: async () => {
          clearInterval(tick);
          clearInterval(persistTick);
          for (const rt of runtimes.values()) {
            try { rt.sim?.disconnect(); } catch { /* ignore */ }
          }
          runtimes.clear();
          store?.close();
          store = null;
          await new Promise((r) => httpServer.close(r));
        },
      };
      if (autoBoot) {
        connectSim(httpServer, { chargerId: chargerRow().id }, { force: true }).catch((err) => {
          console.error("[HMI] auto-boot failed:", err.message);
        });
      }
      resolve(ready);
    });
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  startDemoCsms({ autoBoot: true }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
