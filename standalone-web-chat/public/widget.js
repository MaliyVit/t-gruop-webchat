/* Visitor widget logic (runs inside the iframe created by embed.js).
 *
 * Talks only to its own origin: REST under /api/visitor/*, realtime on /ws.
 * The visitor credential is a random token kept in localStorage and sent as the
 * X-Chat-Visitor-Id header; it is never put in a URL. Message text is always
 * rendered with textContent, never as HTML.
 */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);

  // --- Strings -----------------------------------------------------------------
  const STRINGS = {
    en: {
      open: "Open chat", minimize: "Minimize chat", more: "More", newChat: "New conversation",
      soundOn: "Turn sound on", soundOff: "Turn sound off", start: "Start chat",
      ask: "Your question…", message: "Type a message…", send: "Send",
      waiting: "We usually reply within a few minutes", answering: "Replying to you",
      closed: "Conversation closed", offline: "Connection problem. Retrying…",
      sendFailed: "Message not sent. Press send to try again.",
      startFailed: "Could not start the chat. Please try again.",
      tooMany: "Too many requests. Please wait a moment and try again.",
      tooShort: (n) => `Please write at least ${n} characters.`,
    },
    uk: {
      open: "Відкрити чат", minimize: "Згорнути чат", more: "Ще", newChat: "Нова розмова",
      soundOn: "Увімкнути звук", soundOff: "Вимкнути звук", start: "Почати чат",
      ask: "Ваше запитання…", message: "Напишіть повідомлення…", send: "Надіслати",
      waiting: "Зазвичай відповідаємо за кілька хвилин", answering: "Вам відповідає",
      closed: "Розмову завершено", offline: "Проблема зі зʼєднанням. Повторюємо спробу…",
      sendFailed: "Повідомлення не надіслано. Натисніть «Надіслати» ще раз.",
      startFailed: "Не вдалося почати чат. Спробуйте ще раз.",
      tooMany: "Забагато запитів. Зачекайте хвилину й спробуйте знову.",
      tooShort: (n) => `Напишіть, будь ласка, щонайменше ${n} символи.`,
    },
  };
  let T = STRINGS.en;

  // --- Storage (may be blocked in embedded/private contexts: fall back to memory) -
  const memory = new Map();
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return memory.get(k) ?? null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { memory.set(k, v); } },
    del(k) { try { localStorage.removeItem(k); } catch { memory.delete(k); } },
  };
  const session = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return memory.get("s:" + k) ?? null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch { memory.set("s:" + k, v); } },
    del(k) { try { sessionStorage.removeItem(k); } catch { memory.delete("s:" + k); } },
  };

  // --- Embedding ---------------------------------------------------------------
  const params = new URLSearchParams(location.search);
  const hostPage = params.get("host");
  const embedded = hostPage != null || window.self !== window.top;
  document.body.classList.add(embedded ? "embedded" : "standalone");
  let hostOrigin = "*";
  try { if (hostPage) hostOrigin = new URL(hostPage).origin; } catch { /* keep "*" */ }

  const OPEN_POLL_MS = 3000;
  const CLOSED_POLL_MS = 8000;
  const WS_FALLBACK_MS = 20000; // slow safety-net poll while the socket is live
  const KEY_VISITOR = "chat_visitor_id";
  const KEY_CONV = "chat_conversation_id";
  const KEY_PANEL = "chat_panel_open";
  const KEY_MUTED = "chat_muted";
  const KEY_START_NEW = "chat_start_new";

  const state = {
    conversationId: null, lastMessageId: 0, lastSeenId: 0, unread: 0, open: false,
    timer: null, ws: null, wsConnected: false, wsBackoff: 1000, wsRetry: null,
    failures: 0, lifecycle: null, headerKey: "", armed: false,
  };

  // --- Helpers -------------------------------------------------------------------
  function randomToken() {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""); // 48 hex chars
  }
  function visitorId() {
    let v = store.get(KEY_VISITOR);
    if (!v || !/^[A-Za-z0-9_-]{16,128}$/.test(v)) { v = randomToken(); store.set(KEY_VISITOR, v); }
    return v;
  }
  // Every request gets a timeout: a hanging upstream must surface as an error the
  // visitor can see and retry, not as silence.
  function fetchT(url, opts) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    return fetch(url, { ...(opts || {}), signal: ctl.signal }).finally(() => clearTimeout(timer));
  }
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : randomToken());
  const headers = (extra) => ({ "X-Chat-Visitor-Id": visitorId(), ...(extra || {}) });
  const jsonHeaders = () => headers({ "content-type": "application/json" });
  const initials = (name) => {
    const w = String(name).trim().split(/\s+/).filter(Boolean);
    if (!w.length) return "";
    return (w.length > 1 ? [...w[0]][0] + [...w[1]][0] : [...w[0]].slice(0, 2).join("")).toUpperCase();
  };

  function showNotice(text) { const n = $("notice"); n.textContent = text || ""; n.hidden = !text; }
  function netOk() { state.failures = 0; if ($("notice").dataset.kind === "net") { showNotice(""); delete $("notice").dataset.kind; } }
  function netFail() {
    state.failures++;
    if (state.failures >= 2) { showNotice(T.offline); $("notice").dataset.kind = "net"; }
  }

  // --- Sound ---------------------------------------------------------------------
  let audioCtx = null;
  let muted = store.get(KEY_MUTED) === "1";
  let lastChime = 0;
  function playChime() {
    if (muted) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
      const t0 = audioCtx.currentTime;
      [[880, 0], [1174.66, 0.09]].forEach(([freq, delay]) => {
        const osc = audioCtx.createOscillator(); const gain = audioCtx.createGain();
        osc.type = "sine"; osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t0 + delay);
        gain.gain.exponentialRampToValueAtTime(0.15, t0 + delay + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + delay + 0.28);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(t0 + delay); osc.stop(t0 + delay + 0.3);
      });
    } catch { /* audio is optional */ }
  }
  function chime() { const now = Date.now(); if (now - lastChime < 700) return; lastChime = now; playChime(); }

  // --- Menu ----------------------------------------------------------------------
  function closeMenu(focus) {
    if ($("moreMenu").hidden) return;
    $("moreMenu").hidden = true; $("moreBtn").setAttribute("aria-expanded", "false");
    if (focus) $("moreBtn").focus();
  }
  function openMenu() {
    $("moreMenu").hidden = false; $("moreBtn").setAttribute("aria-expanded", "true");
    $("newBtn").focus();
  }
  $("moreBtn").onclick = () => ($("moreMenu").hidden ? openMenu() : closeMenu(true));
  $("moreMenu").addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeMenu(true); }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      (document.activeElement === $("newBtn") ? $("soundBtn") : $("newBtn")).focus();
    }
  });
  document.addEventListener("pointerdown", (e) => { if (!e.target.closest(".menu-wrap")) closeMenu(false); });
  window.addEventListener("blur", () => closeMenu(false));
  $("soundBtn").onclick = () => {
    muted = !muted; store.set(KEY_MUTED, muted ? "1" : "0"); renderStrings(); closeMenu(true);
    if (!muted) playChime();
  };

  function renderStrings() {
    document.documentElement.lang = T === STRINGS.uk ? "uk" : "en";
    $("fab").setAttribute("aria-label", T.open);
    $("minimize").title = T.minimize; $("minimize").setAttribute("aria-label", T.minimize);
    $("moreBtn").title = T.more; $("moreBtn").setAttribute("aria-label", T.more);
    $("newBtn").textContent = T.newChat;
    $("soundBtn").textContent = muted ? T.soundOn : T.soundOff;
    $("first").placeholder = T.ask; $("first").setAttribute("aria-label", T.ask);
    $("startBtn").textContent = T.start;
    $("input").placeholder = T.message; $("input").setAttribute("aria-label", T.message);
    $("send").title = T.send; $("send").setAttribute("aria-label", T.send);
    state.headerKey = ""; renderHeader(null);
  }

  // --- Header --------------------------------------------------------------------
  let brandTitle = "";
  function renderHeader(vs) {
    const op = vs?.operator_name || null;
    state.lifecycle = vs?.lifecycle ?? state.lifecycle;
    const closed = state.lifecycle === "closed";
    const key = JSON.stringify([op, closed, brandTitle, T === STRINGS.uk]);
    if (key === state.headerKey) return;
    state.headerKey = key;
    $("hdrAvatar").hidden = !op;
    if (op) $("hdrAvatar").textContent = initials(op);
    $("hdrTitle").textContent = op || brandTitle;
    $("hdrSub").textContent = closed ? T.closed : op ? T.answering : T.waiting;
  }

  // --- Views ---------------------------------------------------------------------
  function showStart() { $("start").hidden = false; $("chat").hidden = true; }
  function showChat() { $("start").hidden = true; $("chat").hidden = false; }
  function postState() {
    if (!embedded || window.self === window.top) return;
    window.parent.postMessage({ type: "chat:state", open: state.open }, hostOrigin);
  }
  function renderBadge() {
    $("badge").hidden = state.unread === 0;
    $("badge").textContent = state.unread > 9 ? "9+" : String(state.unread);
  }
  function markSeen() {
    state.lastSeenId = state.lastMessageId; state.unread = 0; renderBadge();
    if (state.conversationId) store.set("chat_last_seen:" + state.conversationId, String(state.lastSeenId));
  }
  function openPanel(restore) {
    state.open = true;
    if (embedded) session.set(KEY_PANEL, "1");
    $("fab").hidden = true; $("panel").hidden = false;
    if (!restore) { $("panel").classList.remove("animate-in"); void $("panel").offsetWidth; $("panel").classList.add("animate-in"); }
    postState(); markSeen();
    $("messages").scrollTop = $("messages").scrollHeight;
    if (!restore) ($("chat").hidden ? $("first") : $("input")).focus();
    if (state.conversationId) { refreshState(); poll(); }
    schedulePoll();
  }
  function closePanel() {
    state.open = false; closeMenu(false);
    $("panel").hidden = true; $("fab").hidden = false;
    postState(); schedulePoll();
  }
  $("fab").onclick = () => openPanel(false);
  $("minimize").onclick = () => { session.del(KEY_PANEL); closePanel(); };

  // --- Messages ------------------------------------------------------------------
  function addMessage(m) {
    const id = Number(m.id);
    if (id <= state.lastMessageId) return; // already shown (poll and socket can race)
    const el = document.createElement("div");
    el.className = "msg " + (m.sender_type === "operator" ? "operator" : "customer");
    el.textContent = m.body;
    el.dataset.mid = String(id);
    $("messages").appendChild(el);
    $("messages").scrollTop = $("messages").scrollHeight;
    state.lastMessageId = id;
    if (m.sender_type === "operator" && id > state.lastSeenId) {
      if (state.open) markSeen(); else { state.unread++; renderBadge(); }
    }
  }

  async function poll() {
    const id = state.conversationId;
    if (!id) return;
    try {
      const res = await fetchT(`/api/visitor/conversations/${id}/messages?after=${state.lastMessageId}`, { headers: headers() });
      if (res.status === 404) return; // handled by send/resume recovery
      if (!res.ok) throw new Error("http " + res.status);
      const msgs = await res.json();
      netOk();
      if (state.conversationId !== id) return; // thread switched while in flight
      const operatorArrived = msgs.some((m) => Number(m.id) > state.lastMessageId && m.sender_type === "operator");
      const closedAndWrote = state.lifecycle === "closed" && msgs.some((m) => m.sender_type === "customer");
      const incoming = state.armed && operatorArrived;
      msgs.forEach(addMessage);
      if (incoming) chime();
      if (operatorArrived || closedAndWrote) refreshState();
      if (msgs.length >= 500) poll(); // more pages waiting
    } catch { netFail(); }
  }

  async function refreshState() {
    const id = state.conversationId;
    if (!id) return;
    try {
      const res = await fetchT(`/api/visitor/conversations/${id}`, { headers: headers() });
      if (!res.ok || state.conversationId !== id) return;
      renderHeader(await res.json());
    } catch { /* the next poll retries */ }
  }

  function schedulePoll() {
    clearInterval(state.timer);
    if (!state.conversationId) return;
    const base = state.open ? OPEN_POLL_MS : CLOSED_POLL_MS;
    state.timer = setInterval(poll, state.wsConnected ? Math.max(base, WS_FALLBACK_MS) : base);
  }

  // --- Realtime (WebSocket pokes; polling is the safety net) -----------------------
  function connectWs() {
    if (!state.conversationId || state.ws) return;
    let ws;
    try {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    } catch { return; }
    state.ws = ws;
    ws.onopen = () => {
      state.wsConnected = true; state.wsBackoff = 1000;
      // The credential travels in the frame, not the URL.
      ws.send(JSON.stringify({ action: "subscribe", conversation: state.conversationId, visitor_id: visitorId() }));
      schedulePoll();
      poll(); // catch up on whatever was missed while disconnected
    };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (String(msg.conversationId) !== String(state.conversationId)) return;
      if (msg.type === "message") poll();
      else if (msg.type === "meta" || msg.type === "subscribed") refreshState();
    };
    ws.onclose = () => {
      state.ws = null; state.wsConnected = false; schedulePoll();
      clearTimeout(state.wsRetry);
      // Exponential backoff with jitter, capped at 15 s.
      state.wsRetry = setTimeout(connectWs, state.wsBackoff + Math.random() * 500);
      state.wsBackoff = Math.min(state.wsBackoff * 2, 15000);
    };
    ws.onerror = () => { try { ws.close(); } catch { /* already closing */ } };
  }
  function disposeWs() {
    clearTimeout(state.wsRetry);
    const ws = state.ws; state.ws = null; state.wsConnected = false;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try { ws.close(); } catch { /* ignore */ }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if (state.conversationId) { connectWs(); poll(); }
  });
  window.addEventListener("online", () => { if (state.conversationId) { connectWs(); poll(); } });

  // --- Resume / start -------------------------------------------------------------
  function resetThread() {
    clearInterval(state.timer); disposeWs();
    state.conversationId = null; state.lastMessageId = 0; state.lastSeenId = 0; state.unread = 0;
    state.lifecycle = null; state.armed = false; renderBadge();
    $("messages").textContent = "";
    state.headerKey = ""; renderHeader(null);
  }

  async function resume(id, fromRestore) {
    let res;
    try {
      res = await fetchT(`/api/visitor/conversations/${id}/messages`, { headers: headers() });
    } catch { netFail(); return; } // offline: keep the stored id, try again later
    if (res.status === 404 || res.status === 400) {
      store.del(KEY_CONV);
      if (!fromRestore) return restoreActive();
      return;
    }
    if (!res.ok) return;
    state.conversationId = id;
    state.lastSeenId = Number(store.get("chat_last_seen:" + id)) || 0; // keeps the badge honest across reloads
    showChat();
    const msgs = await res.json();
    msgs.forEach(addMessage);
    state.armed = true;
    if (state.open) markSeen();
    schedulePoll(); connectWs(); refreshState();
    if (msgs.length >= 500) poll(); // more pages waiting
  }

  async function restoreActive() {
    if (session.get(KEY_START_NEW) === "1") return; // visitor asked for a fresh thread
    let active = null;
    try {
      const res = await fetchT("/api/visitor/conversation", { headers: headers() });
      if (res.ok) active = (await res.json()).conversation;
    } catch { /* offline: stay on the start screen */ }
    if (active) { store.set(KEY_CONV, String(active.id)); return resume(Number(active.id), true); }
  }

  let pendingKey = null; let pendingPayload = null;
  function startKey(text, startNew) {
    const payload = JSON.stringify([text, startNew]);
    if (!pendingKey || pendingPayload !== payload) { pendingKey = uuid(); pendingPayload = payload; }
    return pendingKey;
  }

  async function startConversation(text) {
    const startNew = session.get(KEY_START_NEW) === "1";
    let conv;
    try {
      const res = await fetchT("/api/visitor/conversations", {
        method: "POST", headers: jsonHeaders(),
        body: JSON.stringify({
          first_message: text, source_page: hostPage || undefined,
          start_new: startNew || undefined, idempotency_key: startKey(text, startNew),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        if (err?.code === "message_too_short") showStartError(T.tooShort(err.min_chars));
        else if (res.status === 429) showStartError(T.tooMany);
        else showStartError(T.startFailed);
        return false;
      }
      conv = await res.json();
    } catch { showStartError(T.startFailed); return false; }
    pendingKey = null; pendingPayload = null;
    session.del(KEY_START_NEW);
    $("startError").hidden = true;
    store.set(KEY_CONV, String(conv.id));
    resetThread();
    state.conversationId = Number(conv.id);
    showChat();
    await poll();
    state.armed = true; markSeen();
    schedulePoll(); connectWs(); refreshState();
    return true;
  }
  function showStartError(text) { $("startError").textContent = text; $("startError").hidden = false; }

  $("startBtn").onclick = async () => {
    const text = $("first").value.trim();
    if (!text) return;
    $("startBtn").disabled = true;
    try { if (await startConversation(text)) { $("first").value = ""; $("input").focus(); } }
    finally { $("startBtn").disabled = false; }
  };

  // --- Sending --------------------------------------------------------------------
  // One send attempt keeps one idempotency key until it succeeds or the text changes,
  // so a retry after a lost response never stores the message twice.
  let attempt = null; let inFlight = false;
  async function sendMessage() {
    const body = $("input").value.trim();
    if (!body || !state.conversationId || inFlight) return;
    if (!attempt || attempt.body !== body || attempt.conversationId !== state.conversationId) {
      attempt = { body, conversationId: state.conversationId, key: uuid() };
    }
    inFlight = true; $("send").disabled = true;
    const sent = attempt;
    $("input").value = "";
    try {
      const res = await fetchT(`/api/visitor/conversations/${sent.conversationId}/messages`, {
        method: "POST", headers: jsonHeaders(),
        body: JSON.stringify({ body: sent.body, idempotency_key: sent.key }),
      });
      if (res.status === 404) {
        // The stored conversation no longer exists: carry the text into a new one.
        attempt = null; store.del(KEY_CONV); resetThread();
        if (!(await startConversation(sent.body))) { showStart(); $("first").value = sent.body; }
        return;
      }
      if (!res.ok) {
        $("input").value = sent.body;
        showNotice(res.status === 429 ? T.tooMany : T.sendFailed);
        setTimeout(() => { if ($("notice").dataset.kind !== "net") showNotice(""); }, 4000);
        return;
      }
      attempt = null; netOk(); showNotice("");
      await poll();
    } catch {
      $("input").value = sent.body; netFail(); showNotice(T.sendFailed);
    } finally { inFlight = false; $("send").disabled = false; }
  }
  $("send").onclick = sendMessage;
  $("input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); sendMessage(); } });
  $("first").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("startBtn").click(); }
  });
  $("input").addEventListener("focus", () => { closeMenu(false); setTimeout(() => { $("messages").scrollTop = $("messages").scrollHeight; }, 300); });

  // "New conversation": forget the current thread; the next message starts a fresh one.
  $("newBtn").onclick = () => {
    closeMenu(false);
    store.del(KEY_CONV); session.set(KEY_START_NEW, "1");
    resetThread(); showStart(); $("first").focus();
  };

  // --- Boot -------------------------------------------------------------------------
  (async function boot() {
    try {
      const res = await fetchT("/api/widget-config");
      if (res.ok) {
        const cfg = await res.json();
        if (cfg.locale === "uk") T = STRINGS.uk;
        brandTitle = cfg.title || "";
        $("welcome").textContent = cfg.greeting || "";
        if (/^#[0-9a-fA-F]{6}$/.test(cfg.accent || "")) document.documentElement.style.setProperty("--accent", cfg.accent);
        document.title = brandTitle || "Chat";
      }
    } catch { /* defaults stay */ }
    renderStrings();

    if (embedded) {
      $("minimize").hidden = false;
      if (session.get(KEY_PANEL) === "1") openPanel(true); else closePanel();
    } else {
      state.open = true; $("panel").hidden = false; $("panel").classList.add("animate-in");
    }
    const saved = Number(store.get(KEY_CONV));
    if (Number.isSafeInteger(saved) && saved > 0) await resume(saved, false); else await restoreActive();
  })();
})();
