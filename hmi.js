(() => {
  function chargerId() {
    const q = new URLSearchParams(location.search);
    return q.get("id") || q.get("chargerId") || "";
  }

  function withId(path) {
    const id = chargerId();
    if (!id) return path;
    const u = new URL(path, location.origin);
    u.searchParams.set("id", id);
    return u.pathname + u.search;
  }

  async function request(path, body, method) {
    const verb = method || (body != null ? "POST" : "GET");
    let payload = body;
    if (payload && typeof payload === "object" && chargerId() && payload.chargerId == null) {
      payload = { ...payload, chargerId: Number(chargerId()) };
    }
    const res = await fetch(withId(path), {
      method: verb,
      headers: payload != null && verb !== "GET" && verb !== "DELETE"
        ? { "content-type": "application/json" }
        : undefined,
      body: payload != null && verb !== "GET" && verb !== "DELETE"
        ? JSON.stringify(payload)
        : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function subscribe(onState) {
    let alive = true;
    const pull = async () => {
      if (!alive) return;
      try {
        onState(await request("/api/state"));
      } catch {
        /* keep polling */
      }
    };
    pull();
    const timer = setInterval(pull, 500);
    let es;
    try {
      es = new EventSource(withId("/api/events"));
      es.onmessage = (ev) => {
        try {
          onState(JSON.parse(ev.data));
        } catch {
          /* ignore */
        }
      };
    } catch {
      /* polling only */
    }
    return () => {
      alive = false;
      clearInterval(timer);
      es?.close();
    };
  }

  window.BydApi = { request, subscribe, chargerId, withId };
})();
