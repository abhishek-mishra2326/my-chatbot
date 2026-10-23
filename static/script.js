const $ = (s) => document.querySelector(s);
const chat = $("#chat"), list = $("#messages"), welcome = $("#welcome");
const form = $("#composer"), input = $("#input"), sendBtn = $("#send"), counter = $("#count");

let history = [];
let busy = false;
let controller = null;   // Stop button ke liye

const SPARK = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 2c.6 5.2 4.8 9.4 10 10-5.2.6-9.4 4.8-10 10-.6-5.2-4.8-9.4-10-10C7.2 11.4 11.4 7.2 12 2z"/></svg>';
const ICON_SEND = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
const ICON_STOP = '<svg viewBox="0 0 24 24" width="18" height="18"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>';

/* ---------- Greeting ---------- */
function setGreeting() {
  const h = new Date().getHours();
  const g = h < 5 ? "Raat ke jaagne wale, kya poochna hai?"
    : h < 12 ? "Subah-subah kya seekhna hai?"
    : h < 17 ? "Dopahar mein kaunsa doubt hai?"
    : h < 21 ? "Shaam ko kya samajhna hai?"
    : "Raat ho gayi, kaunsa doubt baaki hai?";
  $("#greeting").textContent = g;
}
setGreeting();

/* ---------- Theme ---------- */
$("#themeBtn").addEventListener("click", () => {
  const root = document.documentElement;
  const dark = getComputedStyle(root).colorScheme.includes("dark");
  const next = dark ? "light" : "dark";
  root.dataset.theme = next;
  try { localStorage.setItem("theme", next); } catch (e) {}
});

/* ---------- Safe markdown-lite (pehle escape, phir formatting) ---------- */
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function md(text) {
  const blocks = [];
  let t = esc(text).replace(/```\w*\n?([\s\S]*?)```/g, (_, code) => {
    blocks.push(code.replace(/\n$/, ""));
    return "\u0000" + (blocks.length - 1) + "\u0000";
  });
  t = t.replace(/`([^`\n]+)`/g, "<code>$1</code>")
       .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  let out = "", inList = false;
  for (const line of t.split("\n")) {
    const m = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/);
    if (m) {
      if (!inList) { out += "<ul>"; inList = true; }
      out += "<li>" + m[1] + "</li>";
    } else {
      if (inList) { out += "</ul>"; inList = false; }
      out += line + "\n";
    }
  }
  if (inList) out += "</ul>";
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => "<pre><code>" + blocks[i] + "</code></pre>").trim();
}

/* ---------- UI helpers ---------- */
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
  el.querySelector(".text").innerHTML = '<span class="dots" aria-label="Saathi soch raha hai"><i></i><i></i><i></i></span>';
  return el;
}

function addCopy(el, text) {
  const copy = document.createElement("button");
  copy.className = "copy";
  copy.type = "button";
  copy.textContent = "Copy";
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(text); copy.textContent = "Copy ho gaya"; }
    catch (e) { copy.textContent = "Copy nahi hua"; }
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
  retry.textContent = "Message wapas box mein daalo";
  retry.addEventListener("click", () => {
    input.value = originalText;
    autosize();
    input.focus();
    el.remove();
  });
  el.querySelector(".tools").appendChild(retry);
  scrollEnd();
}

function setSendMode(streaming) {
  sendBtn.innerHTML = streaming ? ICON_STOP : ICON_SEND;
  sendBtn.setAttribute("aria-label", streaming ? "Jawab rokho" : "Message bhejo");
}

/* ---------- Sending (streaming) ---------- */
async function send(raw) {
  const text = raw.trim();
  if (!text || busy) return;
  busy = true;
  setSendMode(true);
  updateSend();
  welcome.hidden = true;

  addUser(text);
  history.push({ role: "user", content: text });
  const bot = addTyping();
  const target = bot.querySelector(".text");
  controller = new AbortController();
  let reply = "";

  try {
    // Backend ki limits: max 20 messages, har message max 2000 chars, pehla message user ka
    let msgs = history.slice(-20).map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
    while (msgs.length && msgs[0].role !== "user") msgs.shift();

    const res = await fetch("/api/chat-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: msgs }),
      signal: controller.signal,
    });

    if (!res.ok) {
      let data = {};
      try { data = await res.json(); } catch (e) {}
      throw new Error(typeof data.detail === "string" ? data.detail : "Server se jawab nahi aaya, thodi der baad try karo.");
    }

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
    if (!reply.trim()) throw new Error("Khaali jawab aaya, dobara try karo.");
    target.innerHTML = md(reply);
  } catch (err) {
    if (reply.trim()) {
      // Beech mein ruka (Stop ya network), jitna aaya wo rakh lo
      target.innerHTML = md(reply);
    } else {
      bot.remove();
      history.pop();   // fail hua message history se hatao
      if (err.name !== "AbortError") {
        addError(err.message || "Internet ya server ki dikkat hai.", text);
      }
    }
  }

  if (reply.trim()) {
    history.push({ role: "assistant", content: reply });
    addCopy(bot, reply);
  }
  scrollEnd();

  controller = null;
  busy = false;
  setSendMode(false);
  updateSend();
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
// Streaming ke dauran button Stop ban jata hai, isliye enabled rehna chahiye
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
  if (busy) {                      // streaming chal rahi hai to ye Stop hai
    if (controller) controller.abort();
    return;
  }
  const text = input.value;
  input.value = "";
  autosize();
  send(text);
});

document.querySelectorAll(".chip").forEach((c) =>
  c.addEventListener("click", () => send(c.textContent))
);

$("#newChat").addEventListener("click", () => {
  if (busy) return;
  history = [];
  list.innerHTML = "";
  setGreeting();
  welcome.hidden = false;
  input.focus();
});

updateSend();
input.focus();