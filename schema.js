/**
 * OCPP 1.6 JSON schema validation (Charge Point + Central System).
 * additionalProperties is rejected on CALL payloads we accept or emit.
 */

export class OcppSchemaError extends Error {
  constructor(errorCode, message, details = {}) {
    super(message);
    this.ocppErrorCode = errorCode;
    this.errorDescription = message;
    this.errorDetails = details;
  }
}

export function compact(value) {
  if (Array.isArray(value)) return value.map(compact);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (v === undefined || v === null) continue;
      out[key] = compact(v);
    }
    return out;
  }
  return value;
}

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export const ENUM = {
  RegistrationStatus: ["Accepted", "Pending", "Rejected"],
  ChargePointStatus: [
    "Available", "Preparing", "Charging", "SuspendedEVSE", "SuspendedEV",
    "Finishing", "Reserved", "Unavailable", "Faulted",
  ],
  ChargePointErrorCode: [
    "ConnectorLockFailure", "EVCommunicationError", "GroundFailure", "HighTemperature",
    "InternalError", "LocalListConflict", "NoError", "OtherError", "OverCurrentFailure",
    "PowerMeterFailure", "PowerSwitchFailure", "ReaderFailure", "ResetFailure",
    "UnderVoltage", "OverVoltage", "WeakSignal",
  ],
  AuthorizationStatus: ["Accepted", "Blocked", "Expired", "Invalid", "ConcurrentTx"],
  ReadingContext: [
    "Interruption.Begin", "Interruption.End", "Other", "Sample.Clock",
    "Sample.Periodic", "Transaction.Begin", "Transaction.End", "Trigger",
  ],
  ValueFormat: ["Raw", "SignedData"],
  Measurand: [
    "Energy.Active.Export.Register", "Energy.Active.Import.Register",
    "Energy.Reactive.Export.Register", "Energy.Reactive.Import.Register",
    "Energy.Active.Export.Interval", "Energy.Active.Import.Interval",
    "Energy.Reactive.Export.Interval", "Energy.Reactive.Import.Interval",
    "Power.Active.Export", "Power.Active.Import", "Power.Offered",
    "Power.Reactive.Export", "Power.Reactive.Import", "Power.Factor",
    "Current.Import", "Current.Export", "Current.Offered",
    "Voltage", "Frequency", "Temperature", "SoC", "RPM",
  ],
  Phase: ["L1", "L2", "L3", "N", "L1-N", "L2-N", "L3-N", "L1-L2", "L2-L3", "L3-L1"],
  Location: ["Cable", "EV", "Inlet", "Outlet", "Body"],
  UnitOfMeasure: [
    "Wh", "kWh", "varh", "kvarh", "W", "kW", "VA", "kVA", "var", "kvar",
    "A", "V", "K", "Celcius", "Celsius", "Fahrenheit", "Percent",
  ],
  Reason: [
    "EmergencyStop", "EVDisconnected", "HardReset", "Local", "Other", "PowerLoss",
    "Reboot", "Remote", "SoftReset", "UnlockCommand", "DeAuthorized",
  ],
  AvailabilityType: ["Inoperative", "Operative"],
  AvailabilityStatus: ["Accepted", "Rejected", "Scheduled"],
  ResetType: ["Hard", "Soft"],
  ResetStatus: ["Accepted", "Rejected"],
  RemoteStartStopStatus: ["Accepted", "Rejected"],
  UnlockStatus: ["Unlocked", "UnlockFailed", "NotSupported"],
  DataTransferStatus: ["Accepted", "Rejected", "UnknownMessageId", "UnknownVendorId"],
  TriggerMessageStatus: ["Accepted", "Rejected", "NotImplemented"],
  MessageTrigger: [
    "BootNotification", "DiagnosticsStatusNotification", "FirmwareStatusNotification",
    "Heartbeat", "MeterValues", "StatusNotification",
  ],
  ConfigurationStatus: ["Accepted", "Rejected", "RebootRequired", "NotSupported"],
  DiagnosticsStatus: ["Idle", "Uploaded", "UploadFailed", "Uploading"],
  FirmwareStatus: [
    "Downloaded", "DownloadFailed", "Downloading", "Idle",
    "InstallationFailed", "Installing", "Installed",
  ],
  UpdateType: ["Differential", "Full"],
  UpdateStatus: ["Accepted", "Failed", "NotSupported", "VersionMismatch"],
  ReservationStatus: ["Accepted", "Faulted", "Occupied", "Rejected", "Unavailable"],
  CancelReservationStatus: ["Accepted", "Rejected"],
  ChargingProfileStatus: ["Accepted", "Rejected", "NotSupported"],
  ClearChargingProfileStatus: ["Accepted", "Unknown"],
  GetCompositeScheduleStatus: ["Accepted", "Rejected"],
  ChargingProfilePurpose: ["ChargePointMaxProfile", "TxDefaultProfile", "TxProfile"],
  ChargingProfileKind: ["Absolute", "Recurring", "Relative"],
  RecurrencyKind: ["Daily", "Weekly"],
  ChargingRateUnit: ["A", "W"],
};

function ci(max) {
  return { type: "string", maxLength: max, minLength: 1 };
}
function ci0(max) {
  return { type: "string", maxLength: max };
}

const idTagInfo = {
  type: "object",
  required: ["status"],
  additionalProperties: false,
  properties: {
    status: { enum: ENUM.AuthorizationStatus },
    expiryDate: { type: "string", format: "date-time" },
    parentIdTag: ci(20),
  },
};

const sampledValue = {
  type: "object",
  required: ["value"],
  additionalProperties: false,
  properties: {
    value: ci0(50),
    context: { enum: ENUM.ReadingContext },
    format: { enum: ENUM.ValueFormat },
    measurand: { enum: ENUM.Measurand },
    phase: { enum: ENUM.Phase },
    location: { enum: ENUM.Location },
    unit: { enum: ENUM.UnitOfMeasure },
  },
};

const meterValue = {
  type: "object",
  required: ["timestamp", "sampledValue"],
  additionalProperties: false,
  properties: {
    timestamp: { type: "string", format: "date-time" },
    sampledValue: { type: "array", minItems: 1, items: sampledValue },
  },
};

const chargingSchedulePeriod = {
  type: "object",
  required: ["startPeriod", "limit"],
  additionalProperties: false,
  properties: {
    startPeriod: { type: "integer", minimum: 0 },
    limit: { type: "number" },
    numberPhases: { type: "integer", minimum: 1, maximum: 3 },
  },
};

const chargingSchedule = {
  type: "object",
  required: ["chargingRateUnit", "chargingSchedulePeriod"],
  additionalProperties: false,
  properties: {
    duration: { type: "integer", minimum: 0 },
    startSchedule: { type: "string", format: "date-time" },
    chargingRateUnit: { enum: ENUM.ChargingRateUnit },
    chargingSchedulePeriod: { type: "array", minItems: 1, items: chargingSchedulePeriod },
    minChargingRate: { type: "number" },
  },
};

const chargingProfile = {
  type: "object",
  required: ["chargingProfileId", "stackLevel", "chargingProfilePurpose", "chargingProfileKind", "chargingSchedule"],
  additionalProperties: false,
  properties: {
    chargingProfileId: { type: "integer" },
    transactionId: { type: "integer" },
    stackLevel: { type: "integer", minimum: 0 },
    chargingProfilePurpose: { enum: ENUM.ChargingProfilePurpose },
    chargingProfileKind: { enum: ENUM.ChargingProfileKind },
    recurrencyKind: { enum: ENUM.RecurrencyKind },
    validFrom: { type: "string", format: "date-time" },
    validTo: { type: "string", format: "date-time" },
    chargingSchedule,
  },
};

const keyValue = {
  type: "object",
  required: ["key", "readonly"],
  additionalProperties: false,
  properties: {
    key: ci(50),
    readonly: { type: "boolean" },
    value: ci0(500),
  },
};

/** CALL Charge Point → Central System */
export const CALL_FROM_CP = {
  BootNotification: {
    type: "object",
    required: ["chargePointVendor", "chargePointModel"],
    additionalProperties: false,
    properties: {
      chargePointVendor: ci(20),
      chargePointModel: ci(20),
      chargePointSerialNumber: ci(25),
      chargeBoxSerialNumber: ci(25),
      firmwareVersion: ci(50),
      iccid: ci(20),
      imsi: ci(20),
      meterType: ci(25),
      meterSerialNumber: ci(25),
    },
  },
  Heartbeat: { type: "object", additionalProperties: false, properties: {} },
  StatusNotification: {
    type: "object",
    required: ["connectorId", "errorCode", "status"],
    additionalProperties: false,
    properties: {
      connectorId: { type: "integer", minimum: 0 },
      errorCode: { enum: ENUM.ChargePointErrorCode },
      status: { enum: ENUM.ChargePointStatus },
      info: ci0(50),
      timestamp: { type: "string", format: "date-time" },
      vendorId: ci0(255),
      vendorErrorCode: ci0(50),
    },
  },
  Authorize: {
    type: "object",
    required: ["idTag"],
    additionalProperties: false,
    properties: { idTag: ci(20) },
  },
  StartTransaction: {
    type: "object",
    required: ["connectorId", "idTag", "meterStart", "timestamp"],
    additionalProperties: false,
    properties: {
      connectorId: { type: "integer", minimum: 0 },
      idTag: ci(20),
      meterStart: { type: "integer" },
      timestamp: { type: "string", format: "date-time" },
      reservationId: { type: "integer" },
    },
  },
  MeterValues: {
    type: "object",
    required: ["connectorId", "meterValue"],
    additionalProperties: false,
    properties: {
      connectorId: { type: "integer", minimum: 0 },
      transactionId: { type: "integer" },
      meterValue: { type: "array", minItems: 1, items: meterValue },
    },
  },
  StopTransaction: {
    type: "object",
    required: ["meterStop", "timestamp", "transactionId"],
    additionalProperties: false,
    properties: {
      transactionId: { type: "integer" },
      idTag: ci(20),
      timestamp: { type: "string", format: "date-time" },
      meterStop: { type: "integer" },
      reason: { enum: ENUM.Reason },
      transactionData: { type: "array", items: meterValue },
    },
  },
  DiagnosticsStatusNotification: {
    type: "object",
    required: ["status"],
    additionalProperties: false,
    properties: { status: { enum: ENUM.DiagnosticsStatus } },
  },
  FirmwareStatusNotification: {
    type: "object",
    required: ["status"],
    additionalProperties: false,
    properties: { status: { enum: ENUM.FirmwareStatus } },
  },
  DataTransfer: {
    type: "object",
    required: ["vendorId"],
    additionalProperties: false,
    properties: {
      vendorId: ci(255),
      messageId: ci(50),
      data: { type: "string" },
    },
  },
};

/** CALL Central System → Charge Point */
export const CALL_FROM_CSMS = {
  CancelReservation: {
    type: "object",
    required: ["reservationId"],
    additionalProperties: false,
    properties: { reservationId: { type: "integer" } },
  },
  ChangeAvailability: {
    type: "object",
    required: ["connectorId", "type"],
    additionalProperties: false,
    properties: {
      connectorId: { type: "integer", minimum: 0 },
      type: { enum: ENUM.AvailabilityType },
    },
  },
  ChangeConfiguration: {
    type: "object",
    required: ["key", "value"],
    additionalProperties: false,
    properties: { key: ci(50), value: ci0(500) },
  },
  ClearCache: { type: "object", additionalProperties: false, properties: {} },
  ClearChargingProfile: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "integer" },
      connectorId: { type: "integer", minimum: 0 },
      chargingProfilePurpose: { enum: ENUM.ChargingProfilePurpose },
      stackLevel: { type: "integer", minimum: 0 },
    },
  },
  DataTransfer: CALL_FROM_CP.DataTransfer,
  GetCompositeSchedule: {
    type: "object",
    required: ["connectorId", "duration"],
    additionalProperties: false,
    properties: {
      connectorId: { type: "integer", minimum: 0 },
      duration: { type: "integer", minimum: 0 },
      chargingRateUnit: { enum: ENUM.ChargingRateUnit },
    },
  },
  GetConfiguration: {
    type: "object",
    additionalProperties: false,
    properties: {
      key: { type: "array", items: ci(50) },
    },
  },
  GetDiagnostics: {
    type: "object",
    required: ["location"],
    additionalProperties: false,
    properties: {
      location: { type: "string", minLength: 1 },
      retries: { type: "integer", minimum: 0 },
      retryInterval: { type: "integer", minimum: 0 },
      startTime: { type: "string", format: "date-time" },
      stopTime: { type: "string", format: "date-time" },
    },
  },
  GetLocalListVersion: { type: "object", additionalProperties: false, properties: {} },
  RemoteStartTransaction: {
    type: "object",
    required: ["idTag"],
    additionalProperties: false,
    properties: {
      connectorId: { type: "integer", minimum: 0 },
      idTag: ci(20),
      chargingProfile: chargingProfile,
    },
  },
  RemoteStopTransaction: {
    type: "object",
    required: ["transactionId"],
    additionalProperties: false,
    properties: { transactionId: { type: "integer" } },
  },
  ReserveNow: {
    type: "object",
    required: ["connectorId", "expiryDate", "idTag", "reservationId"],
    additionalProperties: false,
    properties: {
      connectorId: { type: "integer", minimum: 0 },
      expiryDate: { type: "string", format: "date-time" },
      idTag: ci(20),
      parentIdTag: ci(20),
      reservationId: { type: "integer" },
    },
  },
  Reset: {
    type: "object",
    required: ["type"],
    additionalProperties: false,
    properties: { type: { enum: ENUM.ResetType } },
  },
  SendLocalList: {
    type: "object",
    required: ["listVersion", "updateType"],
    additionalProperties: false,
    properties: {
      listVersion: { type: "integer" },
      updateType: { enum: ENUM.UpdateType },
      localAuthorizationList: {
        type: "array",
        items: {
          type: "object",
          required: ["idTag"],
          additionalProperties: false,
          properties: { idTag: ci(20), idTagInfo },
        },
      },
    },
  },
  SetChargingProfile: {
    type: "object",
    required: ["connectorId", "csChargingProfiles"],
    additionalProperties: false,
    properties: {
      connectorId: { type: "integer", minimum: 0 },
      csChargingProfiles: chargingProfile,
    },
  },
  TriggerMessage: {
    type: "object",
    required: ["requestedMessage"],
    additionalProperties: false,
    properties: {
      requestedMessage: { enum: ENUM.MessageTrigger },
      connectorId: { type: "integer", minimum: 0 },
    },
  },
  UnlockConnector: {
    type: "object",
    required: ["connectorId"],
    additionalProperties: false,
    properties: { connectorId: { type: "integer", minimum: 0 } },
  },
  UpdateFirmware: {
    type: "object",
    required: ["location", "retrieveDate"],
    additionalProperties: false,
    properties: {
      location: { type: "string", minLength: 1 },
      retrieveDate: { type: "string", format: "date-time" },
      retries: { type: "integer", minimum: 0 },
      retryInterval: { type: "integer", minimum: 0 },
    },
  },
};

/** CALLRESULT Central System → Charge Point (required fields; extra keys ignored) */
export const CALLRESULT_TO_CP = {
  BootNotification: {
    type: "object",
    required: ["status", "currentTime", "interval"],
    additionalProperties: true,
    properties: {
      status: { enum: ENUM.RegistrationStatus },
      currentTime: { type: "string", format: "date-time" },
      interval: { type: "integer", minimum: 0 },
    },
  },
  Heartbeat: {
    type: "object",
    required: ["currentTime"],
    additionalProperties: true,
    properties: { currentTime: { type: "string", format: "date-time" } },
  },
  StatusNotification: { type: "object", additionalProperties: true, properties: {} },
  Authorize: {
    type: "object",
    required: ["idTagInfo"],
    additionalProperties: true,
    properties: { idTagInfo },
  },
  StartTransaction: {
    type: "object",
    required: ["transactionId", "idTagInfo"],
    additionalProperties: true,
    properties: {
      transactionId: { type: "integer" },
      idTagInfo,
    },
  },
  MeterValues: { type: "object", additionalProperties: true, properties: {} },
  StopTransaction: {
    type: "object",
    additionalProperties: true,
    properties: { idTagInfo },
  },
  DiagnosticsStatusNotification: { type: "object", additionalProperties: true, properties: {} },
  FirmwareStatusNotification: { type: "object", additionalProperties: true, properties: {} },
  DataTransfer: {
    type: "object",
    required: ["status"],
    additionalProperties: true,
    properties: {
      status: { enum: ENUM.DataTransferStatus },
      data: { type: "string" },
    },
  },
};

/** CALLRESULT Charge Point → Central System */
export const CALLRESULT_FROM_CP = {
  CancelReservation: {
    type: "object",
    required: ["status"],
    additionalProperties: false,
    properties: { status: { enum: ENUM.CancelReservationStatus } },
  },
  ChangeAvailability: {
    type: "object",
    required: ["status"],
    additionalProperties: false,
    properties: { status: { enum: ENUM.AvailabilityStatus } },
  },
  ChangeConfiguration: {
    type: "object",
    required: ["status"],
    additionalProperties: false,
    properties: { status: { enum: ENUM.ConfigurationStatus } },
  },
  ClearCache: {
    type: "object",
    required: ["status"],
    additionalProperties: false,
    properties: { status: { enum: ["Accepted", "Rejected"] } },
  },
  ClearChargingProfile: {
    type: "object",
    required: ["status"],
    additionalProperties: false,
    properties: { status: { enum: ENUM.ClearChargingProfileStatus } },
  },
  DataTransfer: CALLRESULT_TO_CP.DataTransfer,
  GetCompositeSchedule: {
    type: "object",
    required: ["status"],
    additionalProperties: false,
    properties: {
      status: { enum: ENUM.GetCompositeScheduleStatus },
      connectorId: { type: "integer", minimum: 0 },
      scheduleStart: { type: "string", format: "date-time" },
      chargingSchedule,
    },
  },
  GetConfiguration: {
    type: "object",
    additionalProperties: false,
    properties: {
      configurationKey: { type: "array", items: keyValue },
      unknownKey: { type: "array", items: ci(50) },
    },
  },
  GetDiagnostics: {
    type: "object",
    additionalProperties: false,
    properties: { fileName: ci0(255) },
  },
  GetLocalListVersion: {
    type: "object",
    required: ["listVersion"],
    additionalProperties: false,
    properties: { listVersion: { type: "integer" } },
  },
  RemoteStartTransaction: {
    type: "object",
    required: ["status"],
    additionalProperties: false,
    properties: { status: { enum: ENUM.RemoteStartStopStatus } },
  },
  RemoteStopTransaction: {
    type: "object",
    required: ["status"],
    additionalProperties: false,
    properties: { status: { enum: ENUM.RemoteStartStopStatus } },
  },
  ReserveNow: {
    type: "object",
    required: ["status"],
    additionalProperties: false,
    properties: { status: { enum: ENUM.ReservationStatus } },
  },
  Reset: {
    type: "object",
    required: ["status"],
    additionalProperties: false,
    properties: { status: { enum: ENUM.ResetStatus } },
  },
  SendLocalList: {
    type: "object",
    required: ["status"],
    additionalProperties: false,
    properties: { status: { enum: ENUM.UpdateStatus } },
  },
  SetChargingProfile: {
    type: "object",
    required: ["status"],
    additionalProperties: false,
    properties: { status: { enum: ENUM.ChargingProfileStatus } },
  },
  TriggerMessage: {
    type: "object",
    required: ["status"],
    additionalProperties: false,
    properties: { status: { enum: ENUM.TriggerMessageStatus } },
  },
  UnlockConnector: {
    type: "object",
    required: ["status"],
    additionalProperties: false,
    properties: { status: { enum: ENUM.UnlockStatus } },
  },
  UpdateFirmware: { type: "object", additionalProperties: false, properties: {} },
};

export function validate(schema, value, path = "$") {
  if (!schema) return value;
  const t = schema.type;
  if (schema.enum) {
    if (!schema.enum.includes(value)) {
      throw new OcppSchemaError(
        "PropertyConstraintViolation",
        `${path} must be one of ${schema.enum.join(", ")}`,
        { path, value },
      );
    }
    return value;
  }
  if (t === "string") {
    if (typeof value !== "string") {
      throw new OcppSchemaError("TypeConstraintViolation", `${path} must be a string`, { path });
    }
    if (schema.minLength != null && value.length < schema.minLength) {
      throw new OcppSchemaError("PropertyConstraintViolation", `${path} minLength ${schema.minLength}`, { path });
    }
    if (schema.maxLength != null && value.length > schema.maxLength) {
      throw new OcppSchemaError("PropertyConstraintViolation", `${path} maxLength ${schema.maxLength}`, { path });
    }
    if (schema.format === "date-time" && !DATE_TIME.test(value)) {
      throw new OcppSchemaError("TypeConstraintViolation", `${path} must be ISO8601 date-time`, { path, value });
    }
    return value;
  }
  if (t === "integer") {
    if (!Number.isInteger(value)) {
      throw new OcppSchemaError("TypeConstraintViolation", `${path} must be an integer`, { path, value });
    }
    if (schema.minimum != null && value < schema.minimum) {
      throw new OcppSchemaError("PropertyConstraintViolation", `${path} >= ${schema.minimum}`, { path });
    }
    if (schema.maximum != null && value > schema.maximum) {
      throw new OcppSchemaError("PropertyConstraintViolation", `${path} <= ${schema.maximum}`, { path });
    }
    return value;
  }
  if (t === "number") {
    if (typeof value !== "number" || Number.isNaN(value)) {
      throw new OcppSchemaError("TypeConstraintViolation", `${path} must be a number`, { path });
    }
    return value;
  }
  if (t === "boolean") {
    if (typeof value !== "boolean") {
      throw new OcppSchemaError("TypeConstraintViolation", `${path} must be a boolean`, { path });
    }
    return value;
  }
  if (t === "array") {
    if (!Array.isArray(value)) {
      throw new OcppSchemaError("TypeConstraintViolation", `${path} must be an array`, { path });
    }
    if (schema.minItems != null && value.length < schema.minItems) {
      throw new OcppSchemaError("PropertyConstraintViolation", `${path} minItems ${schema.minItems}`, { path });
    }
    return value.map((item, i) => (schema.items ? validate(schema.items, item, `${path}[${i}]`) : item));
  }
  if (t === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new OcppSchemaError("TypeConstraintViolation", `${path} must be an object`, { path });
    }
    const required = schema.required ?? [];
    for (const key of required) {
      if (value[key] === undefined) {
        throw new OcppSchemaError("FormationViolation", `${path}.${key} is required`, { path: `${path}.${key}` });
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
          throw new OcppSchemaError("FormationViolation", `${path} has unknown property ${key}`, { path, key });
        }
      }
    }
    const out = { ...value };
    for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
      if (out[key] !== undefined) {
        out[key] = validate(propSchema, out[key], `${path}.${key}`);
      }
    }
    return out;
  }
  return value;
}

export function validateCallFromCp(action, payload) {
  const schema = CALL_FROM_CP[action];
  if (!schema) {
    throw new OcppSchemaError("NotImplemented", `Unknown Charge Point action ${action}`);
  }
  return validate(schema, compact(payload), action);
}

export function validateCallFromCsms(action, payload) {
  const schema = CALL_FROM_CSMS[action];
  if (!schema) {
    throw new OcppSchemaError("NotImplemented", `Unknown Central System action ${action}`);
  }
  return validate(schema, compact(payload), action);
}

export function validateCallResultToCp(action, payload) {
  const schema = CALLRESULT_TO_CP[action];
  if (!schema) return compact(payload ?? {});
  return validate(schema, compact(payload ?? {}), `${action}.conf`);
}

export function validateCallResultFromCp(action, payload) {
  const schema = CALLRESULT_FROM_CP[action];
  if (!schema) {
    throw new OcppSchemaError("NotImplemented", `No CALLRESULT schema for ${action}`);
  }
  return validate(schema, compact(payload ?? {}), `${action}.conf`);
}
