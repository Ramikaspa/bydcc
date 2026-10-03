const byd = window.BydApi;

function card(c) {
  const status = c.status || "Offline";
  const connected = c.connected ? "Connected" : "Disconnected";
  return `
    <article class="charger-card" data-id="${c.id}">
      <header>
        <strong>${c.chargePointId}</strong>
        <span class="status-pill ${c.connected ? "" : "bad"}">${status} · ${connected}</span>
      </header>
      <p class="help">#${c.id} · ${c.vendor || "BYD"} ${c.model || ""}</p>
      <div class="form-actions">
        <button class="btn primary" type="button" data-act="open" data-id="${c.id}">Charger screen</button>
        <button class="btn ghost" type="button" data-act="settings" data-id="${c.id}">Settings</button>
        <button class="btn rfid" type="button" data-act="connect" data-id="${c.id}">Boot OCPP</button>
        <button class="btn ghost" type="button" data-act="vars" data-id="${c.id}">Variables</button>
        <button class="btn stop" type="button" data-act="delete" data-id="${c.id}">Delete</button>
      </div>
    </article>
  `;
}

async function refresh() {
  const data = await byd.request("/api/chargers");
  const rows = data.rows || [];
  const live = new Map((data.chargers || []).map((c) => [c.id, c]));
  const merged = rows.map((r) => ({
    id: r.id,
    chargePointId: r.charge_point_id,
    vendor: r.vendor,
    model: r.model,
    connected: live.get(r.id)?.connected,
    status: live.get(r.id)?.status,
  }));
  const list = document.getElementById("list");
  if (!merged.length) {
    list.innerHTML = `<p class="help">No simulators yet. Create the first charger with the form above.</p>`;
    return;
  }
  list.innerHTML = merged.map(card).join("");
}

async function showVars(id) {
  const data = await byd.request(`/api/variables?id=${id}`);
  document.getElementById("varTitle").textContent =
    `Charger ${data.charger?.charge_point_id || id} — variables table + chargers row`;
  document.getElementById("varDump").textContent = JSON.stringify({
    charger: data.charger,
    settings: data.settings,
    variables: data.variables,
  }, null, 2);
}

document.getElementById("btnCreate").onclick = async () => {
  const msg = document.getElementById("createMsg");
  msg.textContent = "";
  try {
    const chargePointId = document.getElementById("newId").value.trim();
    const body = {
      chargePointId: chargePointId || undefined,
      startMode: document.getElementById("newMode").value,
      socStart: Number(document.getElementById("newSoc").value) || 30,
      idTag: document.getElementById("newTag").value || "BYD-RFID-001",
    };
    const created = await byd.request("/api/chargers", body);
    msg.textContent = `Created ${created.charger.charge_point_id}`;
    document.getElementById("newId").value = "";
    await refresh();
    await showVars(created.charger.id);
  } catch (err) {
    msg.textContent = err.message;
  }
};

document.getElementById("list").onclick = async (ev) => {
  const btn = ev.target.closest("button[data-act]");
  if (!btn) return;
  const id = btn.dataset.id;
  const act = btn.dataset.act;
  try {
    if (act === "open") location.href = `/?id=${id}`;
    if (act === "settings") location.href = `/settings?id=${id}`;
    if (act === "connect") {
      await byd.request("/api/connect", { chargerId: Number(id) });
      await refresh();
    }
    if (act === "vars") await showVars(id);
    if (act === "delete") {
      await byd.request(`/api/chargers/${id}`, null, "DELETE");
      document.getElementById("varDump").textContent = "—";
      await refresh();
    }
  } catch (err) {
    document.getElementById("createMsg").textContent = err.message;
  }
};

refresh().catch((err) => {
  document.getElementById("list").innerHTML = `<p class="msg">${err.message}</p>`;
});
