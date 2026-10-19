// Mi Bus EMT: cuenta atrás en vivo + alertas
const REFRESH_MS = 15000;
const $ = (s) => document.querySelector(s);
const state = {
  stops: load("stops", []),         // [{id, alias}]
  data: {},                         // stopId -> respuesta de /api/arrivals
  errors: {},
  watches: [],                      // alertas activas en el servidor
  localFired: new Set(),
  sub: null,
};

// clave de acceso (APP_KEY del servidor): se pide una vez y se guarda en el móvil
async function api(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), "X-App-Key": load("appKey", "") } });
  if (r.status === 401 && !opts._retried) {
    // varias peticiones a la vez comparten la misma pregunta
    askKey ??= Promise.resolve(prompt("Clave de acceso de Mi Bus:")).finally(() => setTimeout(() => (askKey = null), 1000));
    const k = await askKey;
    if (k) { save("appKey", k.trim()); return api(url, { ...opts, _retried: true }); }
  }
  return r;
}
let askKey = null;

function load(k, def) { try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch { return def; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

// ---------- datos ----------
async function refresh() {
  await Promise.all(state.stops.map(async (s) => {
    try {
      const r = await api(`/api/arrivals/${s.id}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      state.data[s.id] = { ...j, received: Date.now() };
      delete state.errors[s.id];
    } catch (e) {
      state.errors[s.id] = e.message;
    }
  }));
  $("#status").textContent = "Actualizado " + new Date().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  render();
}

// segundos restantes descontando lo que ha pasado desde la última respuesta
function remaining(bus, d) {
  if (bus.eta == null) return null;
  return Math.max(0, bus.eta - Math.floor((Date.now() - d.received) / 1000));
}

function fmt(sec) {
  if (sec == null) return "+20 min";
  if (sec < 30) return "Llegando";
  const m = Math.floor(sec / 60), s = sec % 60;
  return m >= 10 ? `${m} min` : `${m}:${String(s).padStart(2, "0")}`;
}

function cls(sec) {
  if (sec == null) return "none";
  return sec <= 180 ? "soon" : sec <= 480 ? "mid" : "ok";
}

// ---------- render ----------
function render() {
  const root = $("#stops");
  if (!state.stops.length) {
    root.innerHTML = `<div class="card"><div class="empty">Añade una parada con el número que aparece en el poste o en la marquesina.</div></div>`;
  } else {
    root.innerHTML = state.stops.map((s) => {
      const d = state.data[s.id], err = state.errors[s.id];
      let rows = "";
      if (err) rows = `<div class="err">⚠️ ${esc(err)}</div>`;
      else if (!d) rows = `<div class="empty">Cargando…</div>`;
      else if (!d.buses.length) rows = `<div class="empty">Sin buses previstos ahora mismo.</div>`;
      else rows = d.buses.map((b, i) => {
        const sec = remaining(b, d);
        const on = state.watches.some((w) => w.stop == s.id && w.line == b.line);
        const dist = b.distance != null && b.distance > 0 ? `${(b.distance / 1000).toFixed(1)} km` : "";
        return `<div class="row">
          <div class="badge">${esc(b.line)}</div>
          <div class="dest">${esc(b.destination || "")}<small>${dist}</small></div>
          <div class="eta ${cls(sec)}" data-stop="${s.id}" data-i="${i}">${fmt(sec)}</div>
          <button class="bell ${on ? "on" : ""}" data-bell="${s.id}|${esc(b.line)}" aria-label="Alerta">${on ? "🔔" : "🔕"}</button>
        </div>`;
      }).join("");
      return `<div class="card">
        <div class="card-head">
          <div class="t"><b>${esc(s.alias || d?.name || "Parada " + s.id)}</b><small>Parada ${s.id}${s.alias && d ? " · " + esc(d.name) : ""}</small></div>
          <button class="ghost" data-del="${s.id}" aria-label="Quitar">✕</button>
        </div>${rows}</div>`;
    }).join("");
  }
  renderAlerts();
}

// solo actualiza los contadores cada segundo (sin rehacer el DOM)
function tick() {
  document.querySelectorAll(".eta[data-stop]").forEach((el) => {
    const d = state.data[el.dataset.stop];
    const b = d?.buses[+el.dataset.i];
    if (!b) return;
    const sec = remaining(b, d);
    el.textContent = fmt(sec);
    el.className = "eta " + cls(sec);
  });
  checkLocalAlerts();
}

function renderAlerts() {
  const box = $("#alerts");
  if (!state.watches.length) { box.innerHTML = ""; return; }
  box.innerHTML = `<h2>Alertas activas</h2>` + state.watches.map((w) => {
    const s = state.stops.find((x) => x.id == w.stop);
    return `<div class="alert-item"><span>🔔 Línea <b>${esc(w.line)}</b> · ${esc(s?.alias || "Parada " + w.stop)} · ${w.minutes} min antes</span>
      <button class="ghost" data-unwatch="${w.id}">Quitar</button></div>`;
  }).join("");
}

function esc(t) { return String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// ---------- alertas ----------
function isIOS() { return /iPhone|iPad|iPod/.test(navigator.userAgent); }
function standalone() { return navigator.standalone || matchMedia("(display-mode: standalone)").matches; }

async function ensureSubscription() {
  if (state.sub) return state.sub;
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return null;
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const { publicKey } = await (await api("/api/vapid")).json();
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
  }
  state.sub = sub.toJSON();
  return state.sub;
}

function b64ToBytes(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function loadWatches() {
  if (!state.sub) { state.watches = load("localWatches", []); return; }
  try {
    const r = await api("/api/watches?endpoint=" + encodeURIComponent(state.sub.endpoint));
    state.watches = await r.json();
  } catch {}
}

let pending = null;
function openSheet(stop, line) {
  pending = { stop, line };
  $("#sheet-title").textContent = `Avisarme del ${line}`;
  $("#sheet-opts").innerHTML = [2, 3, 5, 7, 10, 12, 15, 20].map((m) => `<button data-min="${m}">${m} min</button>`).join("");
  $("#sheet").classList.add("open");
}
function closeSheet() { $("#sheet").classList.remove("open"); pending = null; }

async function createWatch(minutes) {
  const { stop, line } = pending;
  closeSheet();
  const sub = await ensureSubscription().catch(() => null);
  if (!sub) {
    // sin push (no instalada o permiso denegado): aviso solo mientras la app esté abierta
    const w = { id: "local-" + Date.now(), stop, line, minutes, created: Date.now() / 1000 };
    state.watches.push(w);
    save("localWatches", state.watches.filter((x) => String(x.id).startsWith("local-")));
    toast(isIOS() && !standalone()
      ? "Alerta solo con la app abierta. Instálala en la pantalla de inicio para recibirla con el móvil bloqueado."
      : "Alerta creada (solo con la app abierta: no hay permiso de notificaciones).");
  } else {
    const r = await api("/api/watches", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stop, line, minutes, subscription: sub }),
    });
    if (!r.ok) { toast("No se pudo crear la alerta"); return; }
    await loadWatches();
    toast(`🔔 Te aviso cuando el ${line} esté a ${minutes} min`);
  }
  render();
}

async function removeWatch(id) {
  if (!String(id).startsWith("local-")) await api("/api/watches/" + id, { method: "DELETE" });
  state.watches = state.watches.filter((w) => w.id !== id);
  save("localWatches", state.watches.filter((x) => String(x.id).startsWith("local-")));
  render();
}

// con la app abierta, también avisamos en pantalla (y con sonido)
function checkLocalAlerts() {
  for (const w of [...state.watches]) {
    const d = state.data[w.stop];
    if (!d) continue;
    const secs = d.buses.filter((b) => b.line == w.line).map((b) => remaining(b, d)).filter((x) => x != null);
    if (!secs.length) continue;
    const sec = Math.min(...secs);
    if (sec <= w.minutes * 60 && !state.localFired.has(w.id)) {
      state.localFired.add(w.id);
      const m = Math.round(sec / 60);
      toast(`🚌 El ${w.line} llega en ${m ? m + " min" : "nada"}, ¡sal ya!`, true);
      beep();
      if (String(w.id).startsWith("local-")) removeWatch(w.id);
      else setTimeout(() => loadWatches().then(render), 30000); // el servidor la borra al disparar
    }
  }
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.25, 0.5].forEach((t) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.2, ctx.currentTime + t);
      o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.15);
    });
    navigator.vibrate?.([200, 100, 200]);
  } catch {}
}

let toastTimer;
function toast(msg, urgent = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "show" + (urgent ? " urgent" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ""), urgent ? 10000 : 4000);
}

// ---------- eventos ----------
$("#add-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const id = $("#stop-input").value.trim().replace(/\D/g, "");
  if (!id) return;
  if (!state.stops.some((s) => s.id === id)) {
    state.stops.push({ id, alias: $("#alias-input").value.trim() });
    save("stops", state.stops);
  }
  $("#stop-input").value = $("#alias-input").value = "";
  render(); refresh();
});

document.addEventListener("click", (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  if (t.dataset.del) {
    state.stops = state.stops.filter((s) => s.id !== t.dataset.del);
    save("stops", state.stops); render();
  } else if (t.dataset.bell) {
    const [stop, line] = t.dataset.bell.split("|");
    const existing = state.watches.find((w) => w.stop == stop && w.line == line);
    existing ? removeWatch(existing.id) : openSheet(stop, line);
  } else if (t.dataset.min) {
    createWatch(+t.dataset.min);
  } else if (t.dataset.unwatch) {
    removeWatch(t.dataset.unwatch);
  } else if (t.id === "sheet-cancel") closeSheet();
});
$("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") closeSheet(); });

// al volver a la app, refrescamos al momento
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

// ---------- arranque ----------
(async function init() {
  if (isIOS() && !standalone()) $("#install-hint").hidden = false;
  if ("serviceWorker" in navigator) {
    await navigator.serviceWorker.register("/sw.js").catch(() => {});
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager?.getSubscription();
      if (sub) state.sub = sub.toJSON();
    } catch {}
  }
  await loadWatches();
  render();
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
  setInterval(tick, 1000);
})();
