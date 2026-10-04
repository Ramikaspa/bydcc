import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { OcppJsonClient } from "./ocpp_json_client.js";
import { nextSample } from "./byd_physics.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROFILE_PATH = join(__dirname, "byd_120kw_profile.json");

const SAMPLED_MEASURANDS_16 = [
  "Energy.Active.Import.Register",
  "Power.Active.Import",
  "Current.Import",
  "Voltage",
  "SoC",
  "Temperature",
  "Frequency",
  "Power.Factor",
];

const FAULT_MAP = {
  OverTemp: { errorCode: "HighTemperature", info: "Connector/board over-temperature" },
  OverCurrent: { errorCode: "OverCurrentFailure", info: "DC output over-current" },
  GroundFailure: { errorCode: "GroundFailure", info: "Insulation / ground fault" },
};

function isoNow() {
  return new Date().toISOString();
}

function loadProfile(path) {
  return JSON.parse(readFileSync(path ?? DEFAULT_PROFILE_PATH, "utf8"));
}

export function serialFromChargePointId(chargePointId, pattern = "BYD-DC-XXXXXX") {
  if (/^BYD-DC-[0-9A-Z]{6}$/i.test(chargePointId)) {
    return chargePointId.toUpperCase();
  }
  const hash = createHash("sha1").update(String(chargePointId)).digest("hex").slice(0, 6).toUpperCase();
  return pattern.replace("XXXXXX", hash);
}

function num(n, digits = 1) {
  return Number(n).toFixed(digits);
}

export class BydOcppSimulator {
  /**
   * @param {object} [options]
   * @param {string} [options.protocol] 1.6J (default) or 2.0.1
   * @param {object} [options.profile]
   * @param {string} [options.profilePath]
   * @param {string} [options.serialNumber]
   * @param {string} [options.startMode] rfid | pnc | app
   * @param {string} [options.fault] OverTemp | OverCurrent | GroundFailure
   * @param {number} [options.faultAtSoc]
   */
  constructor(options = {}) {
    this.protocol = options.protocol ?? "1.6J";
    this.profile = options.profile ?? loadProfile(options.profilePath);
    this.startMode = (options.startMode ?? "rfid").toLowerCase();
    this.injectedFault = options.fault ?? null;
    this.faultAtSoc = options.faultAtSoc ?? 88;
    this.serialNumber = options.serialNumber ?? null;

    this.client = new OcppJsonClient({
      protocol: this.protocol.startsWith("2") ? "2.0.1" : "1.6J",
      onCall: (action, payload) => this._onCsmsCall(action, payload),
    });

    this.chargePointId = null;
    this.connectorId = 1;
    this.centralSystemUrl = null;

    this.status = "Unavailable";
    this.transactionId = null;
    this.transactionSeq = 0;
    this.idTag = null;
    this.meterWh = 1_250_000;
    this.soc = 30;
    this.sample = null;
    this.availability = { 0: true, 1: true, 2: true };

    this.heartbeatTimer = null;
    this.meterTimer = null;
    this.heartbeatInterval = this.profile.heartbeatInterval ?? 30;
    this.meterInterval = this.profile.meterValueSampleInterval ?? 10;

    this.config = this._defaultConfig();
    this.remoteStartWaiters = [];
    this.faulted = false;
    this._stopRequested = false;
    this.authCache = new Map();
    this.localList = new Map();
    this.localListVersion = 1;
    this.reservations = new Map();
    this.chargingProfiles = [];
  }

  _defaultConfig() {
    const measurands = SAMPLED_MEASURANDS_16.join(",");
    return {
      HeartbeatInterval: String(this.profile.heartbeatInterval ?? 30),
      MeterValueSampleInterval: String(this.profile.meterValueSampleInterval ?? 10),
      MeterValuesSampledData: measurands,
      ClockAlignedDataInterval: "0",
      NumberOfConnectors: String(this.profile.connectors ?? 2),
      ConnectorPhaseRotation: "NotApplicable",
      AuthorizeRemoteTxRequests: "false",
      LocalAuthorizeOffline: "true",
      LocalPreAuthorize: "true",
      StopTransactionOnEVSideDisconnect: "true",
      StopTransactionOnInvalidId: "true",
      UnlockConnectorOnEVSideDisconnect: "true",
      ResetRetries: "3",
      ConnectionTimeOut: "60",
      WebSocketPingInterval: "30",
      ChargeProfileMaxStackLevel: "3",
      ChargingScheduleAllowedChargingRateUnit: "Current,Power",
      ChargingScheduleMaxPeriods: "24",
      MaxChargingProfilesInstalled: "8",
      SupportedFeatureProfiles: "Core,FirmwareManagement,LocalAuthListManagement,Reservation,SmartCharging,RemoteTrigger",
      LocalAuthListEnabled: "true",
      LocalAuthListMaxLength: "100",
      SendLocalListMaxLength: "20",
      GetConfigurationMaxKeys: "50",
      TransactionMessageAttempts: "3",
      TransactionMessageRetryInterval: "10",
    };
  }

  identity() {
    return {
      vendor: this.profile.vendor ?? "BYD",
      model: this.profile.chargePointModel ?? "BYD EV Charger 120kW",
      serialNumber: this.serialNumber ?? serialFromChargePointId(this.chargePointId ?? "BYD-001"),
      firmwareVersion: this.profile.firmwareVersion ?? "V2.3.14-BYD",
      meterSerialNumber: `MTR-${(this.serialNumber ?? "BYD-DC-000000").replace("BYD-DC-", "")}`,
      meterType: this.profile.meterType ?? "BYD-DC-Meter",
    };
  }

  async connect(centralSystemUrl, chargePointId, connectorId = 1) {
    this.centralSystemUrl = centralSystemUrl;
    this.chargePointId = chargePointId;
    this.connectorId = Number(connectorId) || 1;
    if (!this.serialNumber) {
      this.serialNumber = serialFromChargePointId(chargePointId, this.profile.serialPattern);
    }

    const { url, protocol } = await this.client.connect(centralSystemUrl, chargePointId);
    console.log(`[CP] connected ${url} subprotocol=${protocol} serial=${this.serialNumber}`);

    await this._boot();
    await this._notifyStatus(0, "Available");
    await this._notifyStatus(this.connectorId, "Available");
    this.status = "Available";
    this._armHeartbeat();
    await this.client.call("Heartbeat", {}).catch((err) => {
      console.error("[CP] initial Heartbeat failed:", err.message);
    });
    return this;
  }

  async startCharging(idTag, socStart) {
    if (!this.client.connected) {
      throw new Error("Not connected to CSMS");
    }
    this.idTag = idTag ?? "BYD-RFID-001";
    this.soc = clampSoc(socStart ?? 30);
    this._stopRequested = false;
    this.faulted = false;
    this.sample = nextSample(
      { soc: this.soc, energyWh: this.meterWh },
      this.profile,
      0,
    );
    this.sample.soc = this.soc;
    this.sample.energyWh = this.meterWh;

    await this._notifyStatus(this.connectorId, "Preparing");
    this.status = "Preparing";

    if (this.startMode === "app") {
      console.log("[CP] App Start — waiting for CSMS RemoteStartTransaction");
      const remote = await this._waitRemoteStart();
      this.idTag = remote.idTag ?? this.idTag;
      await this._notifyStatus(this.connectorId, "Preparing");
    } else if (this.startMode === "rfid") {
      await this._authorize(this.idTag);
      await this._notifyStatus(this.connectorId, "Preparing");
    } else {
      console.log("[CP] Plug & Charge — ISO 15118 contract, skipping RFID Authorize");
      await this._notifyStatus(this.connectorId, "Preparing");
    }

    if (this._stopRequested) return null;

    const meterStart = Math.round(this.meterWh);
    const tx = await this._startTransaction(this.idTag, meterStart);
    this.transactionId = Number(tx.transactionId);
    this.transactionSeq = 0;
    await this._notifyStatus(this.connectorId, "Charging");
    this.status = "Charging";
    this._firstMeter = true;
    this._armMeterValues();
    await this.sendMeterValues();
    return tx;
  }

  async stopCharging(reason = "EVDisconnected") {
    if (this.status === "Available" && !this.transactionId) return null;
    this._stopRequested = true;
    this._clearMeterTimer();

    if (this.status === "Charging" || this.status === "Faulted" || this.transactionId != null) {
      await this._notifyStatus(this.connectorId, "Finishing");
      this.status = "Finishing";
      const meterStop = Math.round(this.meterWh);
      const result = await this._stopTransaction(meterStop, reason);
      this.transactionId = null;
      await this._notifyStatus(this.connectorId, "Available");
      this.status = "Available";
      return result;
    }

    await this._notifyStatus(this.connectorId, "Available");
    this.status = "Available";
    return null;
  }

  async sendMeterValues() {
    if (!this.client.connected) return;
    const dt = this._firstMeter ? 0 : this.meterInterval;
    this._firstMeter = false;
    this.sample = nextSample(
      { soc: this.soc, energyWh: this.meterWh },
      this.profile,
      this.status === "Charging" ? dt : 0,
    );
    this.soc = this.sample.soc;
    this.meterWh = this.sample.energyWh;

    if (this.injectedFault && this.soc >= this.faultAtSoc && !this.faulted) {
      await this._triggerFault(this.injectedFault);
      return;
    }

    if (this.soc >= 99.95 && this.status === "Charging") {
      console.log("[CP] battery full — stopping (EVDisconnected)");
      await this.stopCharging("EVDisconnected");
      return;
    }

    if (this.protocol.startsWith("2")) {
      if (this.transactionId != null && this.status === "Charging") {
        this.transactionSeq += 1;
        await this.client.call("TransactionEvent", this._txEvent20("Updated", "MeterValuePeriodic"));
      }
      return;
    }

    await this.client.call("MeterValues", {
      connectorId: this.connectorId,
      ...(this.transactionId != null ? { transactionId: Number(this.transactionId) } : {}),
      meterValue: [
        {
          timestamp: isoNow(),
          sampledValue: this._sampledValues16(),
        },
      ],
    });
  }

  disconnect() {
    this._clearHeartbeat();
    this._clearMeterTimer();
    this.client.close();
  }

  /* ---------------- OCPP 1.6 / 2.0.1 outbound ---------------- */

  async _boot() {
    const id = this.identity();
    let payload;
    if (this.protocol.startsWith("2")) {
      payload = {
        chargingStation: {
          serialNumber: id.serialNumber,
          model: id.model,
          vendorName: id.vendor,
          firmwareVersion: id.firmwareVersion,
        },
        reason: "PowerUp",
      };
    } else {
      payload = {
        chargePointVendor: id.vendor,
        chargePointModel: id.model,
        chargePointSerialNumber: id.serialNumber,
        chargeBoxSerialNumber: id.serialNumber,
        firmwareVersion: id.firmwareVersion,
        meterType: id.meterType,
        meterSerialNumber: id.meterSerialNumber,
      };
    }

    const conf = await this.client.call("BootNotification", payload);
    const status = conf.status;
    if (status === "Rejected") {
      throw new Error("BootNotification Rejected by CSMS");
    }
    if (typeof conf.interval === "number" && conf.interval > 0) {
      this.heartbeatInterval = conf.interval;
      this.config.HeartbeatInterval = String(conf.interval);
    }
    if (status === "Pending") {
      console.log("[CP] BootNotification Pending — retrying in 10s");
      await sleep(10000);
      return this._boot();
    }
    console.log(`[CP] BootNotification Accepted heartbeat=${this.heartbeatInterval}s`);
    return conf;
  }

  async _authorize(idTag) {
    if (this.protocol.startsWith("2")) {
      const conf = await this.client.call("Authorize", {
        idToken: { idToken: idTag, type: "ISO14443" },
      });
      const status = conf.idTokenInfo?.status ?? "Accepted";
      if (status !== "Accepted") throw new Error(`Authorize ${status}`);
      return conf;
    }
    const conf = await this.client.call("Authorize", { idTag });
    const status = conf.idTagInfo?.status ?? "Accepted";
    this.authCache.set(idTag, conf.idTagInfo);
    if (status !== "Accepted") throw new Error(`Authorize ${status}`);
    return conf;
  }

  async _startTransaction(idTag, meterStart) {
    if (this.protocol.startsWith("2")) {
      const transactionId = `BYD-TX-${Date.now()}`;
      this.transactionId = transactionId;
      const conf = await this.client.call("TransactionEvent", this._txEvent20("Started", "Authorized", {
        idTag,
        meterStart,
      }));
      return { transactionId, ...conf };
    }
    return this.client.call("StartTransaction", {
      connectorId: this.connectorId,
      idTag,
      meterStart,
      timestamp: isoNow(),
    });
  }

  async _stopTransaction(meterStop, reason) {
    if (this.protocol.startsWith("2")) {
      this.transactionSeq += 1;
      return this.client.call("TransactionEvent", this._txEvent20("Ended", "EVCommunicationLost", {
        meterStop,
        reason,
      }));
    }
    return this.client.call("StopTransaction", {
      transactionId: Number(this.transactionId),
      ...(this.idTag ? { idTag: this.idTag } : {}),
      timestamp: isoNow(),
      meterStop,
      reason,
      transactionData: [
        {
          timestamp: isoNow(),
          sampledValue: this._sampledValues16("Transaction.End"),
        },
      ],
    });
  }

  async _notifyStatus(connectorId, status, extra = {}) {
    if (this.protocol.startsWith("2")) {
      const occupied = ["Preparing", "Charging", "Finishing"].includes(status);
      return this.client.call("StatusNotification", {
        timestamp: isoNow(),
        connectorStatus: occupied ? "Occupied" : status,
        evseId: connectorId === 0 ? 0 : 1,
        connectorId: connectorId === 0 ? 1 : connectorId,
      });
    }
    const payload = {
      connectorId,
      errorCode: extra.errorCode ?? (status === "Faulted" ? "OtherError" : "NoError"),
      status,
      timestamp: isoNow(),
    };
    if (extra.info) payload.info = String(extra.info).slice(0, 50);
    if (extra.vendorId) payload.vendorId = extra.vendorId;
    if (extra.vendorErrorCode) payload.vendorErrorCode = extra.vendorErrorCode;
    return this.client.call("StatusNotification", payload);
  }

  _sampledValues16(context = "Sample.Periodic") {
    const s = this.sample;
    const energy = Math.round(this.meterWh);
    const common = { context, format: "Raw" };
    return [
      { ...common, measurand: "Energy.Active.Import.Register", unit: "Wh", location: "Outlet", value: String(energy) },
      { ...common, measurand: "Power.Active.Import", unit: "W", location: "Outlet", value: num(s.power, 1) },
      { ...common, measurand: "Current.Import", unit: "A", location: "Outlet", value: num(s.current, 2) },
      { ...common, measurand: "Voltage", unit: "V", location: "Outlet", value: num(s.voltage, 1) },
      { ...common, measurand: "SoC", unit: "Percent", location: "EV", value: num(s.soc, 1) },
      { ...common, measurand: "Temperature", unit: "Celsius", location: "Outlet", value: num(s.connectorTemp, 1) },
      { ...common, measurand: "Temperature", unit: "Celsius", location: "Body", value: num(s.boardTemp, 1) },
      { ...common, measurand: "Frequency", location: "Inlet", value: num(s.frequency, 2) },
      { ...common, measurand: "Power.Factor", location: "Inlet", value: num(s.powerFactor, 3) },
    ];
  }

  _meterValue20() {
    const s = this.sample;
    const signed = (value, measurand, unit, extra = {}) => ({
      sampledValue: [
        {
          value,
          measurand,
          ...(unit ? { unitOfMeasure: { unit } } : {}),
          ...extra,
        },
      ],
      timestamp: isoNow(),
    });
    return [
      signed(String(Math.round(this.meterWh)), "Energy.Active.Import.Register", "Wh"),
      signed(num(s.power, 1), "Power.Active.Import", "W"),
      signed(num(s.current, 2), "Current.Import", "A"),
      signed(num(s.voltage, 1), "Voltage", "V"),
      signed(num(s.soc, 1), "SoC", "Percent"),
      signed(num(s.connectorTemp, 1), "Temperature", "Celsius", { location: "Outlet" }),
      signed(num(s.boardTemp, 1), "Temperature", "Celsius", { location: "Body" }),
      signed(num(s.frequency, 2), "Frequency", "Hz"),
      signed(num(s.powerFactor, 3), "Power.Factor"),
    ];
  }

  _txEvent20(eventType, triggerReason, extra = {}) {
    const chargingState = eventType === "Ended"
      ? "Idle"
      : eventType === "Started" || this.status === "Charging"
        ? "Charging"
        : "EVConnected";
    return {
      eventType,
      timestamp: isoNow(),
      triggerReason,
      seqNo: this.transactionSeq,
      transactionInfo: {
        transactionId: String(this.transactionId),
        chargingState,
        ...(eventType === "Ended" ? { stoppedReason: extra.reason ?? "EVDisconnected" } : {}),
      },
      evse: { id: 1, connectorId: this.connectorId },
      idToken: { idToken: extra.idTag ?? this.idTag ?? "BYD-RFID-001", type: "ISO14443" },
      meterValue: this.sample ? this._meterValue20() : undefined,
    };
  }

  /* ---------------- CSMS-initiated operations (OCPP 1.6) ---------------- */

  async _onCsmsCall(action, payload) {
    switch (action) {
      case "GetConfiguration":
        return this._getConfiguration(payload);
      case "ChangeConfiguration":
        return this._changeConfiguration(payload);
      case "RemoteStartTransaction":
        return this._remoteStart(payload);
      case "RemoteStopTransaction":
        return this._remoteStop(payload);
      case "Reset":
        return this._reset(payload);
      case "UnlockConnector":
        return this._unlockConnector(payload);
      case "ChangeAvailability":
        return this._changeAvailability(payload);
      case "TriggerMessage":
        return this._triggerMessage(payload);
      case "DataTransfer":
        return this._dataTransfer(payload);
      case "ClearCache":
        this.authCache.clear();
        return { status: "Accepted" };
      case "GetLocalListVersion":
        return { listVersion: this.localListVersion };
      case "SendLocalList":
        return this._sendLocalList(payload);
      case "GetDiagnostics":
        return this._getDiagnostics(payload);
      case "UpdateFirmware":
        return this._updateFirmware(payload);
      case "SetChargingProfile":
        return this._setChargingProfile(payload);
      case "ClearChargingProfile":
        return this._clearChargingProfile(payload);
      case "GetCompositeSchedule":
        return this._getCompositeSchedule(payload);
      case "ReserveNow":
        return this._reserveNow(payload);
      case "CancelReservation":
        return this._cancelReservation(payload);
      default:
        return { errorCode: "NotImplemented", errorDescription: action };
    }
  }

  _getConfiguration(payload) {
    const keys = payload.key?.length ? payload.key : Object.keys(this.config);
    const configurationKey = [];
    const unknownKey = [];
    for (const key of keys) {
      if (key in this.config) {
        configurationKey.push({
          key,
          readonly: key === "NumberOfConnectors" || key === "SupportedFeatureProfiles",
          value: this.config[key],
        });
      } else {
        unknownKey.push(key);
      }
    }
    const conf = {};
    if (configurationKey.length) conf.configurationKey = configurationKey;
    if (unknownKey.length) conf.unknownKey = unknownKey;
    return conf;
  }

  _changeConfiguration(payload) {
    const { key, value } = payload;
    if (!(key in this.config)) return { status: "NotSupported" };
    if (key === "NumberOfConnectors" || key === "SupportedFeatureProfiles") {
      return { status: "Rejected" };
    }
    this.config[key] = String(value);
    if (key === "HeartbeatInterval") {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) return { status: "Rejected" };
      this.heartbeatInterval = n;
      this._armHeartbeat();
    }
    if (key === "MeterValueSampleInterval") {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) return { status: "Rejected" };
      this.meterInterval = n;
      if (this.status === "Charging") this._armMeterValues();
    }
    if (key === "AuthorizeRemoteTxRequests") {
      this.config[key] = value === "true" ? "true" : "false";
    }
    return { status: "Accepted" };
  }

  _remoteStart(payload) {
    const connectors = Number(this.config.NumberOfConnectors ?? 2);
    const connectorId = payload.connectorId ?? this.connectorId;
    if (connectorId === 0 || connectorId > connectors) return { status: "Rejected" };
    if (this.status === "Charging") return { status: "Rejected" };
    if (!this.availability[connectorId]) return { status: "Rejected" };
    const idTag = payload.idTag;
    if (payload.csChargingProfiles || payload.chargingProfile) {
      this.chargingProfiles.push({
        connectorId,
        profile: payload.chargingProfile ?? payload.csChargingProfiles,
      });
    }
    for (const w of this.remoteStartWaiters.splice(0)) w({ idTag, connectorId });
    if (this.startMode === "app" && this.status === "Preparing") {
      return { status: "Accepted" };
    }
    queueMicrotask(async () => {
      try {
        this.connectorId = connectorId;
        if (this.config.AuthorizeRemoteTxRequests === "true") {
          await this._authorize(idTag);
        }
        await this.startCharging(idTag, this.soc);
      } catch (err) {
        console.error("[CP] RemoteStartTransaction failed:", err.message);
      }
    });
    return { status: "Accepted" };
  }

  _remoteStop(payload) {
    if (this.transactionId == null) return { status: "Rejected" };
    if (Number(payload.transactionId) !== Number(this.transactionId)) {
      return { status: "Rejected" };
    }
    queueMicrotask(() => {
      this.stopCharging("Remote").catch((err) => console.error(err.message));
    });
    return { status: "Accepted" };
  }

  _reset(payload) {
    const type = payload.type;
    const reason = type === "Hard" ? "HardReset" : "SoftReset";
    queueMicrotask(async () => {
      try {
        if (this.transactionId != null) await this.stopCharging(reason);
        console.log(`[CP] Reset ${type} — BootNotification`);
        await sleep(250);
        await this._boot();
        await this._notifyStatus(0, "Available");
        await this._notifyStatus(this.connectorId, "Available");
        this.status = "Available";
      } catch (err) {
        console.error("[CP] reset failed:", err.message);
      }
    });
    return { status: "Accepted" };
  }

  _unlockConnector(payload) {
    const connectors = Number(this.config.NumberOfConnectors ?? 2);
    if (payload.connectorId === 0 || payload.connectorId > connectors) {
      return { status: "NotSupported" };
    }
    if (this.status === "Charging" && payload.connectorId === this.connectorId) {
      return { status: "UnlockFailed" };
    }
    return { status: "Unlocked" };
  }

  _changeAvailability(payload) {
    const connectors = Number(this.config.NumberOfConnectors ?? 2);
    if (payload.connectorId > connectors) return { status: "Rejected" };
    if (this.status === "Charging" && payload.type === "Inoperative"
      && (payload.connectorId === this.connectorId || payload.connectorId === 0)) {
      this.availability[payload.connectorId] = false;
      return { status: "Scheduled" };
    }
    this.availability[payload.connectorId] = payload.type !== "Inoperative";
    const status = payload.type === "Inoperative" ? "Unavailable" : "Available";
    queueMicrotask(() => {
      this._notifyStatus(payload.connectorId, status).catch(() => {});
      if (payload.connectorId === this.connectorId || payload.connectorId === 0) {
        this.status = status;
      }
    });
    return { status: "Accepted" };
  }

  _triggerMessage(payload) {
    const requested = payload.requestedMessage;
    queueMicrotask(async () => {
      try {
        if (requested === "BootNotification") await this._boot();
        else if (requested === "Heartbeat") await this.client.call("Heartbeat", {});
        else if (requested === "StatusNotification") {
          await this._notifyStatus(payload.connectorId ?? this.connectorId, this.status);
        } else if (requested === "MeterValues") await this.sendMeterValues();
        else if (requested === "FirmwareStatusNotification") {
          await this.client.call("FirmwareStatusNotification", { status: "Idle" });
        } else if (requested === "DiagnosticsStatusNotification") {
          await this.client.call("DiagnosticsStatusNotification", { status: "Idle" });
        }
      } catch (err) {
        console.error("[CP] TriggerMessage failed:", err.message);
      }
    });
    return { status: "Accepted" };
  }

  _dataTransfer(payload) {
    if (payload.vendorId !== "BYD") return { status: "UnknownVendorId" };
    return { status: "Accepted", data: payload.data ?? "" };
  }

  _sendLocalList(payload) {
    if (payload.updateType === "Full") this.localList.clear();
    for (const entry of payload.localAuthorizationList ?? []) {
      this.localList.set(entry.idTag, entry.idTagInfo ?? { status: "Accepted" });
    }
    this.localListVersion = payload.listVersion;
    return { status: "Accepted" };
  }

  _getDiagnostics(payload) {
    const fileName = `byd-diag-${this.chargePointId}.log`;
    queueMicrotask(async () => {
      try {
        await this.client.call("DiagnosticsStatusNotification", { status: "Uploading" });
        await this.client.call("DiagnosticsStatusNotification", { status: "Uploaded" });
      } catch (err) {
        console.error("[CP] diagnostics:", err.message);
      }
    });
    void payload;
    return { fileName };
  }

  _updateFirmware(payload) {
    queueMicrotask(async () => {
      try {
        await this.client.call("FirmwareStatusNotification", { status: "Downloading" });
        await this.client.call("FirmwareStatusNotification", { status: "Downloaded" });
        await this.client.call("FirmwareStatusNotification", { status: "Idle" });
      } catch (err) {
        console.error("[CP] firmware:", err.message);
      }
    });
    void payload;
    return {};
  }

  _setChargingProfile(payload) {
    this.chargingProfiles = this.chargingProfiles.filter(
      (p) => !(p.connectorId === payload.connectorId
        && p.profile.stackLevel === payload.csChargingProfiles.stackLevel
        && p.profile.chargingProfilePurpose === payload.csChargingProfiles.chargingProfilePurpose),
    );
    this.chargingProfiles.push({
      connectorId: payload.connectorId,
      profile: payload.csChargingProfiles,
    });
    const unit = payload.csChargingProfiles.chargingSchedule?.chargingRateUnit;
    const limit = payload.csChargingProfiles.chargingSchedule?.chargingSchedulePeriod?.[0]?.limit;
    if (typeof limit === "number") {
      if (unit === "A") this.profile.maxCurrent = Math.min(this.profile.maxCurrent ?? 250, limit);
      if (unit === "W") this.profile.maxPower = Math.min(this.profile.maxPower ?? 120000, limit);
    }
    return { status: "Accepted" };
  }

  _clearChargingProfile(payload) {
    const before = this.chargingProfiles.length;
    const empty = payload.id == null && payload.connectorId == null
      && !payload.chargingProfilePurpose && payload.stackLevel == null;
    if (empty) {
      this.chargingProfiles = [];
      return { status: before ? "Accepted" : "Unknown" };
    }
    this.chargingProfiles = this.chargingProfiles.filter((p) => {
      if (payload.id != null && p.profile.chargingProfileId !== payload.id) return true;
      if (payload.connectorId != null && p.connectorId !== payload.connectorId) return true;
      if (payload.chargingProfilePurpose
        && p.profile.chargingProfilePurpose !== payload.chargingProfilePurpose) return true;
      if (payload.stackLevel != null && p.profile.stackLevel !== payload.stackLevel) return true;
      return false;
    });
    return { status: this.chargingProfiles.length < before ? "Accepted" : "Unknown" };
  }

  _getCompositeSchedule(payload) {
    const unit = payload.chargingRateUnit ?? "W";
    const limit = unit === "A" ? (this.profile.maxCurrent ?? 250) : (this.profile.maxPower ?? 120000);
    return {
      status: "Accepted",
      connectorId: payload.connectorId,
      scheduleStart: isoNow(),
      chargingSchedule: {
        duration: payload.duration,
        chargingRateUnit: unit,
        chargingSchedulePeriod: [{ startPeriod: 0, limit }],
      },
    };
  }

  _reserveNow(payload) {
    if (this.status === "Charging") return { status: "Occupied" };
    if (this.status === "Faulted") return { status: "Faulted" };
    if (!this.availability[payload.connectorId] && payload.connectorId !== 0) return { status: "Unavailable" };
    this.reservations.set(payload.reservationId, payload);
    queueMicrotask(() => this._notifyStatus(payload.connectorId, "Reserved").catch(() => {}));
    return { status: "Accepted" };
  }

  _cancelReservation(payload) {
    if (!this.reservations.has(payload.reservationId)) return { status: "Rejected" };
    const res = this.reservations.get(payload.reservationId);
    this.reservations.delete(payload.reservationId);
    queueMicrotask(() => this._notifyStatus(res.connectorId, "Available").catch(() => {}));
    return { status: "Accepted" };
  }

  async _triggerFault(kind) {
    const mapped = FAULT_MAP[kind];
    if (!mapped) return;
    this.faulted = true;
    this._clearMeterTimer();
    console.log(`[CP] FAULT ${kind} → ${mapped.errorCode}`);
    this.status = "Faulted";
    await this._notifyStatus(this.connectorId, "Faulted", mapped);
    await this.stopCharging("EmergencyStop");
  }

  _waitRemoteStart() {
    return new Promise((resolve) => {
      this.remoteStartWaiters.push(resolve);
    });
  }

  _armHeartbeat() {
    this._clearHeartbeat();
    const ms = this.heartbeatInterval * 1000;
    this.heartbeatTimer = setInterval(() => {
      this.client.call("Heartbeat", {}).catch((err) => {
        console.error("[CP] Heartbeat failed:", err.message);
      });
    }, ms);
    this.heartbeatTimer.unref?.();
  }

  _armMeterValues() {
    this._clearMeterTimer();
    const ms = this.meterInterval * 1000;
    this.meterTimer = setInterval(() => {
      this.sendMeterValues().catch((err) => {
        console.error("[CP] MeterValues failed:", err.message);
      });
    }, ms);
    this.meterTimer.unref?.();
  }

  _clearHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  _clearMeterTimer() {
    if (this.meterTimer) clearInterval(this.meterTimer);
    this.meterTimer = null;
  }
}

function clampSoc(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 30;
  return Math.min(100, Math.max(0, v));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export { loadProfile, DEFAULT_PROFILE_PATH };
