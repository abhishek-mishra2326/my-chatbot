const $ = (s) => document.querySelector(s);
const app = $("#app"), chat = $("#chat"), list = $("#messages"), welcome = $("#welcome");
const form = $("#composer"), input = $("#input"), sendBtn = $("#send"), counter = $("#count");
const convListEl = $("#convList");

let convId = null;        // abhi khuli chat ki id (null = nayi chat)
let conversations = [];
let busy = false;
let controller = null;
let authMode = "login";

const SPARK = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 2c.6 5.2 4.8 9.4 10 10-5.2.6-9.4 4.8-10 10-.6-5.2-4.8-9.4-10-10C7.2 11.4 11.4 7.2 12 2z"/></svg>';
const ICON_SEND = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
const ICON_STOP = '<svg viewBox="0 0 24 24" width="18" height="18"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>';

/* ---------- API helper ---------- */
function errMsg(data) {
  const d = data && data.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return "Invalid input. Check the email format, use a password of at least 8 characters, and keep messages under 2000 characters.";
  return "No response from the server. Please try again shortly.";
}
async function api(path, method = "GET", body) {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) { const err = new Error(errMsg(data)); err.status = res.status; throw err; }
  return data;
}

/* ---------- Greeting, theme ---------- */
function setGreeting() {
  const h = new Date().getHours();
  $("#greeting").textContent = h < 5 ? "Working late? How can I help?"
    : h < 12 ? "Good morning. What are we working on?"
    : h < 17 ? "Good afternoon. How can I help?"
    : h < 21 ? "Good evening. What can I help you with?"
    : "Late night? How can I help?";
}
$("#themeBtn").addEventListener("click", () => {
  const root = document.documentElement;
  const next = getComputedStyle(root).colorScheme.includes("dark") ? "light" : "dark";
  root.dataset.theme = next;
  try { localStorage.setItem("theme", next); } catch (e) {}
});

/* ---------- Safe markdown-lite ---------- */
function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function md(text) {
  const blocks = [];
  let t = esc(text).replace(/```\w*\n?([\s\S]*?)```/g, (_, code) => {
    blocks.push(code.replace(/\n$/, ""));
    return "\u0000" + (blocks.length - 1) + "\u0000";
  });
  t = t.replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  let out = "", inList = false;
  for (const line of t.split("\n")) {
    const m = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/);
    if (m) { if (!inList) { out += "<ul>"; inList = true; } out += "<li>" + m[1] + "</li>"; }
    else { if (inList) { out += "</ul>"; inList = false; } out += line + "\n"; }
  }
  if (inList) out += "</ul>";
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => "<pre><code>" + blocks[i] + "</code></pre>").trim();
}

/* ---------- Message UI ---------- */
function scrollEnd() { chat.scrollTop = chat.scrollHeight; }
function addUser(text) {
  const el = document.createElement("div");
  el.className = "msg user";
  const b = document.createElement("div");
  b.className = "bubble";
  b.textContent = text;
  el.appendChild(b);
  list.appendChild(el);
  scrollEnd();
}
function addBot() {
  const el = document.createElement("div");
  el.className = "msg bot";
  el.innerHTML = '<div class="avatar">' + SPARK + '</div><div class="body"><div class="text"></div><div class="tools"></div></div>';
  list.appendChild(el);
  scrollEnd();
  return el;
}
function addTyping() {
  const el = addBot();
  el.querySelector(".text").innerHTML = '<span class="dots" aria-label="Saathi is typing"><i></i><i></i><i></i></span>';
  return el;
}
function addCopy(el, text) {
  const copy = document.createElement("button");
  copy.className = "copy";
  copy.type = "button";
  copy.textContent = "Copy";
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(text); copy.textContent = "Copied"; }
    catch (e) { copy.textContent = "Copy failed"; }
    setTimeout(() => (copy.textContent = "Copy"), 1500);
  });
  el.querySelector(".tools").appendChild(copy);
}
function addError(message, originalText) {
  const el = addBot();
  el.classList.add("error");
  el.querySelector(".text").textContent = message;
  const retry = document.createElement("button");
  retry.className = "retry";
  retry.type = "button";
  retry.textContent = "Restore message to input";
  retry.addEventListener("click", () => { input.value = originalText; autosize(); input.focus(); el.remove(); });
  el.querySelector(".tools").appendChild(retry);
  scrollEnd();
}
function setSendMode(streaming) {
  sendBtn.innerHTML = streaming ? ICON_STOP : ICON_SEND;
  sendBtn.setAttribute("aria-label", streaming ? "Stop generating" : "Send message");
}

/* ---------- Sidebar: chats ki list ---------- */
function closeSidebar() { app.classList.remove("open"); }
$("#menuBtn").addEventListener("click", () => app.classList.toggle("open"));
$("#backdrop").addEventListener("click", closeSidebar);

function renderConvs() {
  convListEl.innerHTML = "";
  if (!conversations.length) {
    const p = document.createElement("p");
    p.className = "conv-empty";
    p.textContent = "No conversations yet.";
    convListEl.appendChild(p);
    return;
  }
  for (const c of conversations) {
    const row = document.createElement("div");
    row.className = "conv" + (c.id === convId ? " active" : "");
    const t = document.createElement("button");
    t.className = "conv-title";
    t.type = "button";
    t.textContent = c.title;
    t.addEventListener("click", () => openConversation(c.id));
    const d = document.createElement("button");
    d.className = "conv-del";
    d.type = "button";
    d.setAttribute("aria-label", "Delete conversation");
    d.textContent = "×";
    d.addEventListener("click", () => deleteConversation(c.id));
    row.append(t, d);
    convListEl.appendChild(row);
  }
}
async function loadConversations() {
  try { conversations = await api("/api/conversations"); renderConvs(); }
  catch (e) { if (e.status === 401) showAuth(); }
}
async function openConversation(id) {
  if (busy) return;
  try {
    const data = await api("/api/conversations/" + id);
    convId = id;
    list.innerHTML = "";
    welcome.hidden = true;
    for (const m of data.messages) {
      if (m.role === "user") addUser(m.content);
      else { const b = addBot(); b.querySelector(".text").innerHTML = md(m.content); addCopy(b, m.content); }
    }
    renderConvs();
    closeSidebar();
    scrollEnd();
  } catch (e) { if (e.status === 401) showAuth(); }
}
async function deleteConversation(id) {
  if (busy || !confirm("Delete this conversation permanently?")) return;
  try {
    await api("/api/conversations/" + id, "DELETE");
    if (id === convId) newChat();
    await loadConversations();
  } catch (e) { if (e.status === 401) showAuth(); }
}
function newChat() {
  if (busy) return;
  convId = null;
  list.innerHTML = "";
  setGreeting();
  welcome.hidden = false;
  renderConvs();
  closeSidebar();
  input.focus();
}
$("#newChat").addEventListener("click", newChat);

/* ---------- Auth ---------- */
function setAuthMode(mode) {
  authMode = mode;
  const login = mode === "login";
  $("#authTitle").textContent = login ? "Welcome back" : "Create your account";
  $("#authSub").textContent = login ? "Log in to access your chat history." : "Sign up to save your conversations.";
  $("#authSubmit").textContent = login ? "Login" : "Create account";
  $("#authToggle").textContent = login ? "Create an account" : "Already have an account? Log in";
  $("#password").autocomplete = login ? "current-password" : "new-password";
  $("#authError").hidden = true;
}
function showAuth() {
  convId = null; conversations = []; list.innerHTML = ""; welcome.hidden = false;
  renderConvs();
  $("#password").value = "";
  $("#auth").hidden = false;
  $("#email").focus();
}
function showApp(email) {
  $("#auth").hidden = true;
  $("#userEmail").textContent = email;
  setGreeting();
  loadConversations();
  input.focus();
}
$("#authToggle").addEventListener("click", () => setAuthMode(authMode === "login" ? "signup" : "login"));
$("#authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#authSubmit"), errEl = $("#authError");
  btn.disabled = true;
  errEl.hidden = true;
  try {
    const me = await api("/api/" + authMode, "POST", { email: $("#email").value.trim(), password: $("#password").value });
    showApp(me.email);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
  btn.disabled = false;
});
$("#logoutBtn").addEventListener("click", async () => {
  try { await api("/api/logout", "POST"); } catch (e) {}
  closeSidebar();
  showAuth();
});

/* ---------- Sending (streaming) ---------- */
async function send(raw) {
  const text = raw.trim();
  if (!text || busy) return;
  busy = true;
  setSendMode(true);
  updateSend();
  welcome.hidden = true;

  addUser(text);
  const bot = addTyping();
  const target = bot.querySelector(".text");
  controller = new AbortController();
  let reply = "";

  try {
    const res = await fetch("/api/chat-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ conversation_id: convId, message: text.slice(0, 2000) }),
      signal: controller.signal,
    });
    if (!res.ok) {
      let data = null;
      try { data = await res.json(); } catch (e) {}
      const err = new Error(errMsg(data));
      err.status = res.status;
      throw err;
    }
    const cid = res.headers.get("X-Conversation-Id");
    if (cid) convId = Number(cid);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      reply += decoder.decode(value, { stream: true });
      target.innerHTML = md(reply);
      scrollEnd();
    }
    reply += decoder.decode();
    if (!reply.trim()) throw new Error("The response was empty. Please try again.");
    target.innerHTML = md(reply);
  } catch (err) {
    if (reply.trim()) {
      target.innerHTML = md(reply);      // Stop ya network toota: jitna aaya wo rakho
    } else {
      bot.remove();
      if (err.status === 401) showAuth();
      else if (err.name !== "AbortError") addError(err.message || "Network or server error. Please try again.", text);
    }
  }

  if (reply.trim()) addCopy(bot, reply);
  controller = null;
  busy = false;
  setSendMode(false);
  updateSend();
  scrollEnd();
  loadConversations();       // title aur order refresh
  input.focus();
}

/* ---------- Composer ---------- */
function autosize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
  const len = input.value.length;
  counter.hidden = len < 1500;
  counter.textContent = len + " / 2000";
  updateSend();
}
function updateSend() { sendBtn.disabled = !busy && !input.value.trim(); }

input.addEventListener("input", autosize);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!busy) form.requestSubmit();
  }
});
form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (busy) { if (controller) controller.abort(); return; }   // streaming ke dauran ye Stop hai
  const text = input.value;
  input.value = "";
  autosize();
  send(text);
});
document.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => send(c.textContent)));

/* ---------- Start ---------- */
(async function init() {
  setGreeting();
  updateSend();
  try { const me = await api("/api/me"); showApp(me.email); }
  catch (e) { showAuth(); }
})();