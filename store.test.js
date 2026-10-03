import test from "node:test";
import assert from "node:assert/strict";
import { openStore, chargerToSettings } from "../store.js";
import { startDemoCsms } from "../demo_csms.js";

test("SQLite store persists chargers and variables", () => {
  const store = openStore(":memory:");
  try {
    const a = store.seedDefault();
    assert.equal(a.charge_point_id, "BYD-001");
    const b = store.createCharger({ chargePointId: "BYD-002", socStart: 42, startMode: "pnc" });
    assert.equal(b.soc_start, 42);
    assert.equal(b.start_mode, "pnc");
    store.setVariables(b.id, { status: "Available", soc: 42, nested: { ok: true } });
    const vars = store.getVariables(b.id);
    assert.equal(vars.status, "Available");
    assert.equal(vars.soc, 42);
    assert.equal(vars.nested.ok, true);
    const settings = chargerToSettings(store.getCharger(b.id));
    assert.equal(settings.chargePointId, "BYD-002");
    store.updateCharger(b.id, { heartbeatInterval: 15 });
    assert.equal(store.getCharger(b.id).heartbeat_interval, 15);
    store.deleteCharger(b.id);
    assert.equal(store.getCharger(b.id), null);
    assert.equal(store.listChargers().length, 1);
  } finally {
    store.close();
  }
});

test("fleet HTTP creates a second simulator and stores live variables", async () => {
  const csms = await startDemoCsms({ port: 0, dbPath: ":memory:" });
  const port = csms.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const created = await fetch(`${base}/api/chargers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chargePointId: "BYD-FLEET-2", socStart: 55 }),
    });
    assert.equal(created.status, 201);
    const body = await created.json();
    const id = body.charger.id;
    const connect = await fetch(`${base}/api/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chargerId: id }),
    });
    assert.equal(connect.status, 200);
    const snap = await connect.json();
    assert.equal(snap.connected, true);
    assert.equal(snap.settings.chargePointId, "BYD-FLEET-2");

    const varsRes = await fetch(`${base}/api/variables?id=${id}`);
    const vars = await varsRes.json();
    assert.equal(vars.charger.charge_point_id, "BYD-FLEET-2");
    assert.equal(vars.variables.connected, true);
    assert.equal(typeof vars.variables.status, "string");

    const list = await (await fetch(`${base}/api/chargers`)).json();
    assert.ok(list.rows.some((r) => r.charge_point_id === "BYD-001"));
    assert.ok(list.rows.some((r) => r.charge_point_id === "BYD-FLEET-2"));
  } finally {
    await csms.close();
  }
});
