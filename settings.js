const byd = window.BydApi;
const fields = [
  "chargePointId", "ocppUrl", "protocol", "heartbeatInterval",
  "meterValueSampleInterval", "startMode", "idTag", "socStart",
  "maxPower", "maxCurrent", "brightness",
];

function fill(s) {
  const st = s.settings || {};
  for (const key of fields) {
    const el = document.getElementById(key);
    if (el && document.activeElement !== el) el.value = st[key] ?? "";
  }
  document.getElementById("ocppDot").className = `dot ${s.connected ? "on" : "off"}`;
  if (s.chargerId) {
    document.getElementById("screenLink").href = `/?id=${s.chargerId}`;
  }
  const id = s.identity;
  document.getElementById("identityHelp").textContent = id
    ? `${id.vendor} · ${id.model} · ${id.serialNumber} · ${id.firmwareVersion}`
    : "Press reboot to send BootNotification.";
}

function readForm() {
  const body = {};
  for (const key of fields) {
    const el = document.getElementById(key);
    if (!el) continue;
    body[key] = el.type === "number" ? Number(el.value) : el.value;
  }
  return body;
}

document.getElementById("form").onsubmit = async (ev) => {
  ev.preventDefault();
  const msg = document.getElementById("saveMsg");
  try {
    fill(await byd.request("/api/settings", readForm()));
    msg.textContent = "Settings saved.";
  } catch (err) {
    msg.textContent = err.message;
  }
};

document.getElementById("btnReboot").onclick = async () => {
  const msg = document.getElementById("saveMsg");
  try {
    fill(await byd.request("/api/settings", { ...readForm(), reboot: true }));
    msg.textContent = "Charger rebooted and BootNotification sent.";
  } catch (err) {
    msg.textContent = err.message;
  }
};

byd.subscribe(fill);

async function csms(action, payload) {
  const out = document.getElementById("csmsOut");
  try {
    const res = await byd.request("/api/csms/call", { action, payload });
    out.textContent = JSON.stringify(res.result, null, 2);
  } catch (err) {
    out.textContent = err.message;
  }
}

document.getElementById("btnCfg").onclick = () => csms("GetConfiguration", {
  key: ["HeartbeatInterval", "MeterValueSampleInterval", "NumberOfConnectors", "SupportedFeatureProfiles"],
});
document.getElementById("btnRemoteStart").onclick = () => {
  const idTag = document.getElementById("idTag").value || "BYD-RFID-001";
  return csms("RemoteStartTransaction", { idTag, connectorId: 1 });
};
document.getElementById("btnRemoteStop").onclick = async () => {
  const s = await byd.request("/api/state");
  if (s.transactionId == null) {
    document.getElementById("csmsOut").textContent = "No active transaction";
    return;
  }
  return csms("RemoteStopTransaction", { transactionId: Number(s.transactionId) });
};
document.getElementById("btnReset").onclick = () => csms("Reset", { type: "Soft" });

