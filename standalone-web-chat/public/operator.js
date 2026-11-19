/* Operator inbox. All data from the server is rendered with textContent only. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const state = {
    list: [], selected: null, lastMessageId: 0, conv: null,
    ws: null, wsConnected: false, wsBackoff: 1000, wsRetry: null, pollTimer: null, refreshTimer: null,
  };

  function el(tag, props, ...kids) {
    const node = document.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
      if (k === "class") node.className = v; else if (k === "text") node.textContent = v; else node.setAttribute(k, v);
    }
    for (const kid of kids) if (kid) node.append(kid);
    return node;
  }
  const fmt = (iso) => {
    const d = new Date(iso); const now = new Date();
    return d.toDateString() === now.toDateString()
      ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString([], { day: "numeric", month: "short" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };
  const pageLabel = (page) => { try { const u = new URL(page); return u.host + u.pathname; } catch { return ""; } };

  async function api(path, opts) {
    const res = await fetch(path, { ...(opts || {}), headers: { "content-type": "application/json", ...((opts && opts.headers) || {}) } });
    if (res.status === 401 && !path.startsWith("/api/auth/")) { showLogin(); throw new Error("unauthorized"); }
    return res;
  }
  function banner(text) { $("banner").textContent = text || ""; $("banner").hidden = !text; }

  // --- Auth ---------------------------------------------------------------------
  function showLogin() {
    teardownRealtime();
    $("app").hidden = true; $("login").hidden = false; $("password").value = "";
  }
  async function showApp(operator) {
    $("login").hidden = true; $("app").hidden = false; $("who").textContent = operator.display_name;
    await refreshList();
    connectWs(); schedulePoll();
  }
  $("login").addEventListener("submit", async (e) => {
    e.preventDefault(); $("loginError").hidden = true;
    const res = await fetch("/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: $("email").value, password: $("password").value }),
    });
    if (!res.ok) {
      $("loginError").textContent = res.status === 429 ? "Too many attempts. Wait a minute and try again." : "Invalid email or password.";
      $("loginError").hidden = false; return;
    }
    showApp((await res.json()).operator);
  });
  $("logout").onclick = async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    state.selected = null; showLogin();
  };

  // --- List ---------------------------------------------------------------------
  async function refreshList() {
    const q = new URLSearchParams();
    if ($("statusFilter").value) q.set("status", $("statusFilter").value);
    q.set("spam", $("spamFilter").value);
    let res;
    try { res = await api("/api/conversations?" + q); } catch { return; }
    if (!res.ok) return;
    const data = await res.json();
    state.list = data.conversations;
    renderList();
  }
  function renderList() {
    const ul = $("list"); ul.textContent = "";
    if (!state.list.length) { ul.append(el("li", { class: "empty", text: "No conversations" })); return; }
    for (const c of state.list) {
      const title = el("span", { class: "title", text: "Visitor #" + c.id });
      const row1 = el("div", { class: "row" }, title,
        c.suspected_spam ? el("span", { class: "spam", text: "SPAM?" }) : null,
        c.unread_count > 0 ? el("span", { class: "unread", text: String(c.unread_count) }) : null,
        el("span", { class: "when", text: fmt(c.last_activity_at) }));
      const row2 = el("div", { class: "row" }, el("span", { class: "chip " + c.status, text: c.status }),
        el("span", { class: "preview", text: c.last_message || "" }));
      const btn = el("button", { class: "conv" + (String(c.id) === String(state.selected) ? " selected" : ""), type: "button" }, row1, row2);
      btn.onclick = () => selectConversation(c.id);
      ul.append(el("li", null, btn));
    }
  }
  $("statusFilter").onchange = refreshList;
  $("spamFilter").onchange = refreshList;

  // --- Thread -------------------------------------------------------------------
  function renderMessage(m) {
    const who = m.sender_type === "operator" ? (m.sender_name || "Operator") : "Visitor";
    return el("div", { class: "msg " + m.sender_type, "data-id": String(m.id) },
      el("span", { text: m.body }), el("small", { text: who + " · " + fmt(m.created_at) }));
  }
  function applyConvMeta(c) {
    state.conv = c;
    $("threadTitle").textContent = "Visitor #" + c.id;
    $("threadSub").textContent = (c.source_page ? pageLabel(c.source_page) + " · " : "") + "started " + fmt(c.created_at);
    $("statusSelect").value = c.status;
    $("notSpam").hidden = !c.suspected_spam;
    if (document.activeElement !== $("refInput")) $("refInput").value = c.external_ref || "";
    const closed = c.status === "resolved" || c.status === "closed";
    $("composer").hidden = closed; $("closedNote").hidden = !closed;
  }
  async function selectConversation(id) {
    state.selected = id; state.lastMessageId = 0;
    $("main").classList.add("show-thread");
    const res = await api("/api/conversations/" + id);
    if (!res.ok) { banner("Could not load the conversation."); return; }
    banner("");
    const c = await res.json();
    $("placeholder").hidden = true; $("threadHead").hidden = false; $("thread").hidden = false;
    $("thread").textContent = "";
    c.messages.forEach((m) => { $("thread").append(renderMessage(m)); state.lastMessageId = Math.max(state.lastMessageId, Number(m.id)); });
    $("thread").scrollTop = $("thread").scrollHeight;
    applyConvMeta(c);
    renderList();
    markSeen();
    wsSubscribeThread();
    $("reply").focus();
  }
  async function fetchNewMessages() {
    if (!state.selected) return;
    const id = state.selected;
    const res = await api(`/api/conversations/${id}/messages?after=${state.lastMessageId}`);
    if (!res.ok || state.selected !== id) return;
    const msgs = await res.json();
    const box = $("thread");
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    for (const m of msgs) {
      if (Number(m.id) <= state.lastMessageId) continue;
      box.append(renderMessage(m)); state.lastMessageId = Number(m.id);
    }
    if (msgs.length && atBottom) box.scrollTop = box.scrollHeight;
    if (msgs.length) markSeen();
  }
  async function refreshMeta() {
    if (!state.selected) return;
    const id = state.selected;
    const res = await api("/api/conversations/" + id);
    if (res.ok && state.selected === id) applyConvMeta(await res.json());
  }
  async function markSeen() {
    if (!state.selected || !state.lastMessageId) return;
    await api(`/api/conversations/${state.selected}/seen`, { method: "POST", body: JSON.stringify({ last_message_id: state.lastMessageId }) }).catch(() => {});
  }

  $("composer").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = $("reply").value.trim();
    if (!body || !state.selected) return;
    $("sendBtn").disabled = true;
    try {
      const res = await api(`/api/conversations/${state.selected}/messages`, {
        method: "POST", body: JSON.stringify({ body, idempotency_key: crypto.randomUUID() }),
      });
      if (res.ok) { $("reply").value = ""; banner(""); await fetchNewMessages(); await refreshMeta(); refreshListSoon(); }
      else if (res.status === 409) { banner("This conversation is closed. Reopen it to reply."); await refreshMeta(); }
      else banner("Message not sent (" + res.status + "). Your text is kept; try again.");
    } catch { /* unauthorized handled in api() */ }
    finally { $("sendBtn").disabled = false; }
  });
  $("reply").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("composer").requestSubmit(); }
  });

  async function patch(fields) {
    if (!state.selected) return;
    const res = await api("/api/conversations/" + state.selected, { method: "PATCH", body: JSON.stringify(fields) });
    if (!res.ok) { banner("Update failed: " + ((await res.json().catch(() => ({}))).error || res.status)); await refreshMeta(); return; }
    banner(""); await refreshMeta(); refreshListSoon();
  }
  $("statusSelect").onchange = () => patch({ status: $("statusSelect").value });
  $("notSpam").onclick = () => patch({ suspected_spam: false });
  $("reopen").onclick = () => patch({ status: "open" });
  $("refSave").onclick = () => patch({ external_ref: $("refInput").value.trim() || null });
  $("back").onclick = () => { $("main").classList.remove("show-thread"); };

  function refreshListSoon() { clearTimeout(state.refreshTimer); state.refreshTimer = setTimeout(refreshList, 150); }

  // --- Realtime + polling fallback --------------------------------------------------
  function wsSend(obj) { if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(obj)); }
  function wsSubscribeThread() { if (state.selected) wsSend({ action: "subscribe", conversation: Number(state.selected) }); }
  function connectWs() {
    if (state.ws) return;
    let ws;
    try { ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`); } catch { return; }
    state.ws = ws;
    ws.onopen = () => {
      state.wsConnected = true; state.wsBackoff = 1000;
      wsSend({ action: "subscribe", inbox: true }); wsSubscribeThread();
      refreshList(); fetchNewMessages(); schedulePoll();
    };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "inbox") refreshListSoon();
      else if (msg.type === "message" && String(msg.conversationId) === String(state.selected)) fetchNewMessages();
      else if (msg.type === "meta" && String(msg.conversationId) === String(state.selected)) refreshMeta();
    };
    ws.onclose = () => {
      state.ws = null; state.wsConnected = false; schedulePoll();
      clearTimeout(state.wsRetry);
      if ($("app").hidden) return;
      state.wsRetry = setTimeout(connectWs, state.wsBackoff + Math.random() * 500);
      state.wsBackoff = Math.min(state.wsBackoff * 2, 15000);
    };
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  }
  function schedulePoll() {
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(() => {
      refreshList(); fetchNewMessages().catch(() => {});
    }, state.wsConnected ? 30000 : 5000);
  }
  function teardownRealtime() {
    clearInterval(state.pollTimer); clearTimeout(state.wsRetry);
    const ws = state.ws; state.ws = null; state.wsConnected = false;
    if (ws) { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; try { ws.close(); } catch { /* ignore */ } }
  }

  // --- Boot ---------------------------------------------------------------------
  fetch("/api/auth/me").then(async (res) => {
    if (res.ok) showApp((await res.json()).operator); else showLogin();
  }).catch(showLogin);
})();
