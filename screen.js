const byd = window.BydApi;

const $ = (id) => document.getElementById(id);
let state = null;
let busy = false;

function tickClock() {
  $("clock").textContent = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
setInterval(tickClock, 1000);
tickClock();

function gunLabel(id, s) {
  if (s.status === "Charging" && Number(s.connectorId) === id) return "Charging now";
  if (s.plugged?.[id]) return "Plugged in — tap RFID";
  return "Available — tap to plug in";
}

function render(s) {
  state = s;
  const charging = s.status === "Charging";
  const preparing = s.status === "Preparing";
  const connected = Boolean(s.connected);
  $("ocppDot").className = `dot ${connected ? "on" : "off"}`;
  $("cpId").textContent = s.settings?.chargePointId || "BYD-001";
  $("pill").textContent = s.status || "Unavailable";
  $("pill").className = `status-pill ${charging ? "busy" : s.status === "Faulted" ? "bad" : ""}`;
  $("lcd").style.setProperty("--brightness", String((Number(s.settings?.brightness ?? 90) / 100) * 0.4 + 0.6));

  const soc = s.sample?.soc ?? s.settings?.socStart ?? 0;
  $("ring").style.setProperty("--soc", `${soc}%`);
  $("socLabel").innerHTML = `${Number(soc).toFixed(0)}%<small>SoC</small>`;
  $("mPower").textContent = `${((s.sample?.power ?? 0) / 1000).toFixed(1)} kW`;
  $("mCurrent").textContent = `${(s.sample?.current ?? 0).toFixed(0)} A`;
  $("mVoltage").textContent = `${(s.sample?.voltage ?? 0).toFixed(0)} V`;
  $("mEnergy").textContent = `${(s.session?.kwh ?? 0).toFixed(2)} kWh`;
  $("modeLabel").textContent = ({ rfid: "RFID", pnc: "Plug & Charge", app: "App" }[s.settings?.startMode] || s.settings?.startMode || "RFID");
  $("identity").textContent = s.identity
    ? `${s.identity.model} · ${s.identity.serialNumber}`
    : "Waiting";
  $("fw").textContent = `Firmware ${s.identity?.firmwareVersion ?? "—"}`;
  if (s.chargerId) {
    $("settingsLink").href = `/settings?id=${s.chargerId}`;
    $("fleetLink").href = "/fleet";
  }

  const cid = Number(s.connectorId || 1);
  $("gun1").classList.toggle("active", cid === 1);
  $("gun2").classList.toggle("active", cid === 2);
  $("gun1s").textContent = gunLabel(1, s);
  $("gun2s").textContent = gunLabel(2, s);

  if (!connected) {
    $("prompt").textContent = "Charger is booting";
    $("headline").textContent = "Connecting to the management system…";
  } else if (charging) {
    $("prompt").textContent = "Charging session in progress";
    $("headline").textContent = "Charging the vehicle";
  } else if (preparing || s.plugged?.[cid]) {
    $("prompt").textContent = "Cable connected";
    $("headline").textContent = s.settings?.startMode === "pnc" ? "Plug & Charge — press Start" : "Tap RFID card";
  } else {
    $("prompt").textContent = "Ready for service";
    $("headline").textContent = "Plug in the charging cable";
  }

  $("btnStop").disabled = busy || (!charging && !preparing);
  $("btnRfid").disabled = busy || charging || !connected;
  $("btnStart").disabled = busy || charging || !connected;
}

async function run(fn) {
  busy = true;
  $("error").textContent = "";
  try {
    render({ ...(state || {}), connected: state?.connected });
    const next = await fn();
    render(next);
  } catch (err) {
    $("error").textContent = err.message;
  } finally {
    busy = false;
    if (state) render(state);
  }
}

$("gun1").onclick = () => run(() => byd.request("/api/plug", { connectorId: 1, plugged: true }));
$("gun2").onclick = () => run(() => byd.request("/api/plug", { connectorId: 2, plugged: true }));
$("btnRfid").onclick = () => run(() => byd.request("/api/start", { idTag: state?.settings?.idTag || "BYD-RFID-001" }));
$("btnStart").onclick = () => run(() => byd.request("/api/start", {}));
$("btnStop").onclick = () => run(() => byd.request("/api/stop", {}));

byd.subscribe((s) => {
  if (!busy) render(s);
  else state = s;
});

byd.request("/api/connect", {}).catch((err) => {
  $("error").textContent = err.message;
});
