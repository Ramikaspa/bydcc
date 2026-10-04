import test from "node:test";
import assert from "node:assert/strict";
import { nextSample, targetPowerW } from "./byd_physics.js";
import { serialFromChargePointId, BydOcppSimulator } from "./byd_charger_simulator.js";
import { startDemoCsms } from "./demo_csms.js";

const profile = {
  vendor: "BYD",
  model: "BYD-DC-120",
  chargePointModel: "BYD EV Charger 120kW",
  maxPower: 120000,
  maxCurrent: 250,
  voltageMin: 380,
  voltageMax: 420,
  connectors: 2,
  meterValueSampleInterval: 1,
  heartbeatInterval: 30,
  batteryCapacityKwh: 80,
  firmwareVersion: "V2.3.14-BYD",
  ccPowerMin: 100000,
  ccPowerMax: 120000,
  tricklePower: 7000,
  cvSocStart: 80,
  trickleSocStart: 95,
};

test("serial number follows BYD-DC-XXXXXX", () => {
  assert.equal(serialFromChargePointId("BYD-DC-123ABC"), "BYD-DC-123ABC");
  assert.match(serialFromChargePointId("BYD-001"), /^BYD-DC-[0-9A-F]{6}$/);
});

test("charging curve is CC then taper then trickle", () => {
  const p40 = targetPowerW(40, profile);
  const p80 = targetPowerW(80, profile);
  const p90 = targetPowerW(90, profile);
  const p98 = targetPowerW(98, profile);
  assert.ok(p40 >= 100000 && p40 <= 120000, `CC power ${p40}`);
  assert.ok(p80 >= 100000, `80% still high ${p80}`);
  assert.ok(p90 < p80, "CV drop");
  assert.ok(p98 < 12000, `trickle ${p98}`);
});

test("samples stay inside BYD electrical envelope and energy increases", () => {
  let state = { soc: 30, energyWh: 1_000_000 };
  for (let i = 0; i < 8; i++) {
    state = nextSample(state, profile, 10);
    assert.ok(state.voltage >= 380 && state.voltage <= 420);
    assert.ok(state.current >= 0 && state.current <= 250);
    assert.ok(state.power >= 0 && state.power <= 120000);
    assert.ok(state.soc >= 20 && state.soc <= 100);
  }
  assert.ok(state.energyWh > 1_000_000);
});

test("full OCPP 1.6J session against demo CSMS", async () => {
  const csms = await startDemoCsms({ port: 0 });
  const port = csms.httpServer.address().port;
  const frames = [];
  const sim = new BydOcppSimulator({
    protocol: "1.6J",
    profile: { ...profile, heartbeatInterval: 60, meterValueSampleInterval: 60 },
    startMode: "rfid",
  });
  const origCall = sim.client.call.bind(sim.client);
  sim.client.call = async (action, payload) => {
    frames.push(action);
    return origCall(action, payload);
  };
  sim.meterInterval = 60;

  try {
    await sim.connect(`ws://127.0.0.1:${port}/ocpp`, "BYD-001", 1);
    assert.equal(sim.identity().vendor, "BYD");
    assert.equal(sim.identity().model, "BYD EV Charger 120kW");
    await sim.startCharging("RFID-AA11", 30);
    assert.ok(sim.transactionId);
    await sim.sendMeterValues();
    const energyAfter = sim.meterWh;
    await sim.sendMeterValues();
    assert.ok(sim.meterWh > energyAfter, "energy register is incremental");
    const soc = sim.soc;
    assert.ok(soc >= 20 && soc <= 100);
    await sim.stopCharging("Local");
    assert.ok(frames.includes("BootNotification"));
    assert.ok(frames.includes("Heartbeat"));
    assert.ok(frames.includes("Authorize"));
    assert.ok(frames.includes("StartTransaction"));
    assert.ok(frames.includes("MeterValues"));
    assert.ok(frames.includes("StopTransaction"));
    assert.ok(frames.filter((a) => a === "StatusNotification").length >= 4);
  } finally {
    sim.disconnect();
    await csms.close();
  }
});
