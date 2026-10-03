import test from "node:test";
import assert from "node:assert/strict";
import {
  OcppSchemaError,
  validateCallFromCp,
  validateCallFromCsms,
  validateCallResultToCp,
} from "../ocpp16/schema.js";

test("BootNotification model fits CiString20", () => {
  const model = "BYD EV Charger 120kW";
  assert.equal(model.length, 20);
  const payload = validateCallFromCp("BootNotification", {
    chargePointVendor: "BYD",
    chargePointModel: model,
    chargePointSerialNumber: "BYD-DC-42A91C",
    firmwareVersion: "V2.3.14-BYD",
  });
  assert.equal(payload.chargePointVendor, "BYD");
});

test("rejects extra properties and missing required fields", () => {
  assert.throws(
    () => validateCallFromCp("Authorize", { idTag: "RFID-AA11", extra: true }),
    (err) => err instanceof OcppSchemaError && err.ocppErrorCode === "FormationViolation",
  );
  assert.throws(
    () => validateCallFromCsms("RemoteStartTransaction", { connectorId: 1 }),
    (err) => err instanceof OcppSchemaError && err.ocppErrorCode === "FormationViolation",
  );
  assert.throws(
    () => validateCallFromCp("StatusNotification", {
      connectorId: 1,
      errorCode: "NoError",
      status: "Charging",
      timestamp: "not-a-date",
    }),
    (err) => err.ocppErrorCode === "TypeConstraintViolation",
  );
});

test("MeterValues measurands match 1.6 UnitOfMeasure (no Hertz)", () => {
  const payload = validateCallFromCp("MeterValues", {
    connectorId: 1,
    transactionId: 1000,
    meterValue: [{
      timestamp: "2026-10-03T12:00:00.000Z",
      sampledValue: [
        { value: "1250000", measurand: "Energy.Active.Import.Register", unit: "Wh", context: "Sample.Periodic", format: "Raw", location: "Outlet" },
        { value: "101000.0", measurand: "Power.Active.Import", unit: "W", context: "Sample.Periodic", format: "Raw", location: "Outlet" },
        { value: "50.02", measurand: "Frequency", context: "Sample.Periodic", format: "Raw", location: "Inlet" },
      ],
    }],
  });
  assert.equal(payload.meterValue[0].sampledValue.length, 3);
  assert.throws(
    () => validateCallFromCp("MeterValues", {
      connectorId: 1,
      meterValue: [{
        timestamp: "2026-10-03T12:00:00.000Z",
        sampledValue: [{ value: "50", measurand: "Frequency", unit: "Hertz" }],
      }],
    }),
    (err) => err.ocppErrorCode === "PropertyConstraintViolation",
  );
});

test("BootNotification.conf requires status, currentTime, interval", () => {
  const conf = validateCallResultToCp("BootNotification", {
    status: "Accepted",
    currentTime: "2026-10-03T12:00:00Z",
    interval: 30,
  });
  assert.equal(conf.interval, 30);
  assert.throws(
    () => validateCallResultToCp("BootNotification", { status: "Accepted", currentTime: "2026-10-03T12:00:00Z" }),
    (err) => err.ocppErrorCode === "FormationViolation",
  );
});
