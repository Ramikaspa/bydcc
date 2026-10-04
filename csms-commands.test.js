import test from "node:test";
import assert from "node:assert/strict";
import { BydOcppSimulator } from "./byd_charger_simulator.js";
import { startDemoCsms } from "./demo_csms.js";

const profile = {
  vendor: "BYD",
  chargePointModel: "BYD EV Charger 120kW",
  maxPower: 120000,
  maxCurrent: 250,
  voltageMin: 380,
  voltageMax: 420,
  connectors: 2,
  meterValueSampleInterval: 60,
  heartbeatInterval: 60,
  batteryCapacityKwh: 80,
  firmwareVersion: "V2.3.14-BYD",
};

function waitFor(pred, ms = 3000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > ms) return reject(new Error("timeout"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

test("CSMS GetConfiguration, RemoteStart, RemoteStop, Reset", async () => {
  const csms = await startDemoCsms({ port: 0 });
  const port = csms.httpServer.address().port;
  const sim = new BydOcppSimulator({ protocol: "1.6J", profile, startMode: "rfid" });
  sim.meterInterval = 60;
  try {
    await sim.connect(`ws://127.0.0.1:${port}/ocpp`, "BYD-001", 1);
    const cfg = await csms.csmsCall("BYD-001", "GetConfiguration", {
      key: ["HeartbeatInterval", "NumberOfConnectors"],
    });
    assert.equal(cfg.configurationKey[0].readonly, false);
    assert.equal(cfg.configurationKey.find((k) => k.key === "NumberOfConnectors").value, "2");
    assert.equal(cfg.configurationKey.find((k) => k.key === "NumberOfConnectors").readonly, true);

    const ch = await csms.csmsCall("BYD-001", "ChangeConfiguration", {
      key: "MeterValueSampleInterval",
      value: "10",
    });
    assert.equal(ch.status, "Accepted");
    assert.equal(sim.meterInterval, 10);

    const unlock = await csms.csmsCall("BYD-001", "UnlockConnector", { connectorId: 1 });
    assert.equal(unlock.status, "Unlocked");

    const started = await csms.csmsCall("BYD-001", "RemoteStartTransaction", {
      idTag: "RFID-AA11",
      connectorId: 1,
    });
    assert.equal(started.status, "Accepted");
    await waitFor(() => sim.status === "Charging" && sim.transactionId != null);
    assert.equal(typeof sim.transactionId, "number");

    const trig = await csms.csmsCall("BYD-001", "TriggerMessage", {
      requestedMessage: "MeterValues",
      connectorId: 1,
    });
    assert.equal(trig.status, "Accepted");

    const stopped = await csms.csmsCall("BYD-001", "RemoteStopTransaction", {
      transactionId: sim.transactionId,
    });
    assert.equal(stopped.status, "Accepted");
    await waitFor(() => sim.status === "Available");

    const reset = await csms.csmsCall("BYD-001", "Reset", { type: "Soft" });
    assert.equal(reset.status, "Accepted");
  } finally {
    sim.disconnect();
    await csms.close();
  }
});
