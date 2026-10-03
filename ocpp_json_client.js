import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  OcppSchemaError,
  compact,
  validateCallFromCp,
  validateCallFromCsms,
  validateCallResultToCp,
  validateCallResultFromCp,
} from "./ocpp16/schema.js";

export const CALL = 2;
export const CALLRESULT = 3;
export const CALLERROR = 4;

const SUBPROTOCOLS = {
  "1.6": "ocpp1.6",
  "1.6J": "ocpp1.6",
  "2.0.1": "ocpp2.0.1",
};

const ERROR_CODES = new Set([
  "NotImplemented", "NotSupported", "InternalError", "ProtocolError",
  "SecurityError", "FormationViolation", "PropertyConstraintViolation",
  "OccurrenceConstraintViolation", "TypeConstraintViolation", "GenericError",
]);

/**
 * OCPP 1.6 JSON-over-WebSocket client (Charge Point role).
 * CALL = [2, uniqueId, action, payload]
 * CALLRESULT = [3, uniqueId, payload]
 * CALLERROR = [4, uniqueId, errorCode, errorDescription, errorDetails]
 */
export class OcppJsonClient {
  constructor({ protocol = "1.6J", requestTimeoutMs = 30000, onCall, logger, strict = true } = {}) {
    this.protocol = protocol;
    this.requestTimeoutMs = requestTimeoutMs;
    this.onCall = onCall;
    this.strict = strict && !String(protocol).startsWith("2");
    this.logger = logger ?? ((dir, frame) => {
      const arrow = dir === "out" ? "→ CSMS" : "← CSMS";
      console.log(`[OCPP ${arrow}] ${JSON.stringify(frame)}`);
    });
    this.ws = null;
    this.pending = new Map();
    this.handlersBound = false;
  }

  subprotocol() {
    return SUBPROTOCOLS[this.protocol] ?? "ocpp1.6";
  }

  connectUrl(centralSystemUrl, chargePointId) {
    const trimmed = centralSystemUrl.replace(/\/+$/, "");
    if (trimmed.endsWith(`/${chargePointId}`)) return trimmed;
    return `${trimmed}/${chargePointId}`;
  }

  connect(centralSystemUrl, chargePointId) {
    const url = this.connectUrl(centralSystemUrl, chargePointId);
    const sub = this.subprotocol();

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, [sub]);
      this.ws = ws;

      const onOpen = () => {
        this._bind();
        resolve({ url, protocol: ws.protocol || sub });
      };
      const onError = (err) => {
        ws.off("open", onOpen);
        reject(err);
      };

      ws.once("open", onOpen);
      ws.once("error", onError);
    });
  }

  _bind() {
    if (!this.ws || this.handlersBound) return;
    this.handlersBound = true;
    this.ws.on("message", (data) => this._onMessage(data));
    this.ws.on("close", (code, reason) => {
      const msg = reason?.toString?.() || "";
      console.log(`[WS] closed ${code} ${msg}`);
      this._failAll(new Error(`WebSocket closed (${code})`));
    });
    this.ws.on("error", (err) => {
      console.error(`[WS] error: ${err.message}`);
    });
  }

  _onMessage(data) {
    let frame;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      console.error("[OCPP] invalid JSON frame", data.toString());
      return;
    }
    this.logger("in", frame);
    if (!Array.isArray(frame) || frame.length < 2) {
      console.error("[OCPP] ProtocolError: frame is not a message array");
      return;
    }

    const type = frame[0];
    const uniqueId = String(frame[1]);
    if (uniqueId.length === 0 || uniqueId.length > 36) {
      console.error("[OCPP] ProtocolError: uniqueId length");
      return;
    }

    if (type === CALLRESULT || type === CALLERROR) {
      const pending = this.pending.get(uniqueId);
      if (!pending) return;
      this.pending.delete(uniqueId);
      clearTimeout(pending.timer);
      if (type === CALLERROR) {
        const err = new Error(frame[3] || frame[2] || "CALLERROR");
        err.ocppErrorCode = frame[2];
        err.ocppDetails = frame[4];
        pending.reject(err);
        return;
      }
      try {
        const payload = frame[2] ?? {};
        const checked = this.strict
          ? validateCallResultToCp(pending.action, payload)
          : payload;
        pending.resolve(checked);
      } catch (err) {
        pending.reject(err);
      }
      return;
    }

    if (type === CALL) {
      const action = frame[2];
      const payload = frame[3] ?? {};
      this._handleCall(uniqueId, action, payload).catch((err) => {
        console.error(`[OCPP] handler failed for ${action}: ${err.message}`);
        this.callError(uniqueId, "InternalError", err.message).catch(() => {});
      });
      return;
    }

    console.error("[OCPP] ProtocolError: unknown MessageTypeId", type);
  }

  async _handleCall(uniqueId, action, payload) {
    if (this.strict) {
      try {
        payload = validateCallFromCsms(action, payload);
      } catch (err) {
        const code = err.ocppErrorCode && ERROR_CODES.has(err.ocppErrorCode)
          ? err.ocppErrorCode
          : "FormationViolation";
        await this.callError(uniqueId, code, err.message, err.errorDetails ?? {});
        return;
      }
    }
    if (!this.onCall) {
      await this.callError(uniqueId, "NotImplemented", `${action} is not implemented`);
      return;
    }
    const result = await this.onCall(action, payload);
    if (result && result.errorCode) {
      await this.callError(
        uniqueId,
        result.errorCode,
        result.errorDescription ?? "",
        result.errorDetails ?? {},
      );
      return;
    }
    let conf = compact(result ?? {});
    if (this.strict) {
      try {
        conf = validateCallResultFromCp(action, conf);
      } catch (err) {
        await this.callError(uniqueId, "InternalError", err.message, err.errorDetails ?? {});
        return;
      }
    }
    await this.callResult(uniqueId, conf);
  }

  send(frame) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("WebSocket is not open"));
    }
    this.logger("out", frame);
    return new Promise((resolve, reject) => {
      this.ws.send(JSON.stringify(frame), (err) => (err ? reject(err) : resolve()));
    });
  }

  call(action, payload = {}) {
    let body = compact(payload);
    if (this.strict) {
      body = validateCallFromCp(action, body);
    }
    const uniqueId = randomUUID();
    const frame = [CALL, uniqueId, action, body];
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(uniqueId);
        reject(new Error(`Timeout waiting for ${action} confirmation`));
      }, this.requestTimeoutMs);
      this.pending.set(uniqueId, { resolve, reject, timer, action });
      this.send(frame).catch((err) => {
        clearTimeout(timer);
        this.pending.delete(uniqueId);
        reject(err);
      });
    });
  }

  callResult(uniqueId, payload = {}) {
    return this.send([CALLRESULT, uniqueId, compact(payload)]);
  }

  callError(uniqueId, errorCode, errorDescription = "", errorDetails = {}) {
    const code = ERROR_CODES.has(errorCode) ? errorCode : "GenericError";
    return this.send([CALLERROR, uniqueId, code, String(errorDescription ?? ""), compact(errorDetails ?? {})]);
  }

  _failAll(err) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  close(code = 1000, reason = "NormalClosure") {
    this._failAll(new Error("client closed"));
    this.handlersBound = false;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(code, reason);
    }
    this.ws = null;
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
