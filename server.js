/**
 * Roblox Player Data Manager (Open Cloud Data Stores v2)
 * - Sidebar lookup + history
 * - Tabs filter JSON output
 * - Power Mode follows current tab (worldwide filter)
 * - Save/Reset only (no extra edit fields)
 * - Safe updates with ETag (If-Match)
 *
 * Node 18+ recommended (built-in fetch).
 */

require("dotenv").config();

const express = require("express");
const app = express();

app.use(express.json({ limit: "2mb" }));

// ================== CONFIG ==================
const ROBLOX_API_KEY = process.env.ROBLOX_API_KEY;
const UNIVERSE_ID = process.env.UNIVERSE_ID;
const DATASTORE_ID = process.env.DATASTORE_ID;
const SCOPE = process.env.SCOPE || "global";
const PORT = Number(process.env.PORT || 3000);

// Optional: protect write endpoints
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ""; // if set, UI must provide it for writes
// ============================================

if (!ROBLOX_API_KEY || ROBLOX_API_KEY.includes("PASTE")) {
  console.error("❌ Set ROBLOX_API_KEY in .env");
  process.exit(1);
}
if (!UNIVERSE_ID || !DATASTORE_ID) {
  console.error("❌ Set UNIVERSE_ID and DATASTORE_ID in .env");
  process.exit(1);
}

// ---------- Utility ----------
async function fetchJson(url, options = {}, { timeoutMs = 10000, retries = 2 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const r = await fetch(url, { ...options, signal: controller.signal });
      const text = await r.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }

      if (!r.ok) {
        const err = new Error(`HTTP ${r.status}`);
        err.status = r.status;
        err.details = json;

        if ((r.status === 429 || r.status >= 500) && attempt < retries) {
          const backoff = 250 * Math.pow(2, attempt);
          await new Promise((s) => setTimeout(s, backoff));
          continue;
        }
        throw err;
      }
      return json;
    } finally {
      clearTimeout(t);
    }
  }
}

function entryUrl(entryId) {
  return (
    `https://apis.roblox.com/cloud/v2/universes/${encodeURIComponent(UNIVERSE_ID)}` +
    `/data-stores/${encodeURIComponent(DATASTORE_ID)}` +
    `/scopes/${encodeURIComponent(SCOPE)}` +
    `/entries/${encodeURIComponent(entryId)}`
  );
}

async function usernameToUserId(username) {
  const userLookup = await fetchJson("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
  });

  if (!userLookup.data || userLookup.data.length === 0) return null;
  return userLookup.data[0].id;
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return next();
  const token = req.header("x-admin-token") || "";
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// Deep set helper: sets obj[path[0]][path[1]]... = value (creating objects along the way)
function setAtPath(root, pathArr, value) {
  let cur = root;
  for (let i = 0; i < pathArr.length - 1; i++) {
    const k = pathArr[i];
    if (cur[k] == null || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k];
  }
  cur[pathArr[pathArr.length - 1]] = value;
}

function isPlainObject(x) {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

// ---------- Health ----------
app.get("/health", (req, res) => res.json({ ok: true }));

// ---------- UI ----------
app.get("/", (req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Roblox Player Data Manager</title>
  <style>
    :root {
      --border: #1f2a44;
      --text: #e5e7eb;
      --muted: #94a3b8;
      --accent: #7dd3fc;
      --good: #86efac;
      --bad: #fecaca;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #070b14;
      color: var(--text);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    }
    .app {
      display: grid;
      grid-template-columns: 320px 1fr;
      min-height: 100vh;
    }
    .sidebar {
      background: #050812;
      border-right: 1px solid var(--border);
      padding: 14px;
    }
    .main {
      background: #070b14;
      padding: 18px;
    }
    h1 {
      font-size: 16px;
      margin: 0 0 10px;
      color: var(--text);
    }
    h2 {
      font-size: 14px;
      margin: 18px 0 8px;
      color: var(--muted);
      font-weight: 600;
      letter-spacing: .02em;
    }
    .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
    input, button, textarea {
      background: #0b1220;
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 10px 12px;
      font-size: 13px;
      outline: none;
    }
    textarea { width: 100%; min-height: 260px; resize: vertical; line-height: 1.35; }
    input { width: 100%; }
    button { cursor: pointer; }
    button:hover { border-color: var(--accent); }
    .btn-primary { border-color: #2b4a67; }
    .btn-danger { border-color: #7f1d1d; }
    .btn-danger:hover { border-color: #ef4444; }

    .status {
      margin-top: 10px;
      padding: 10px 12px;
      border-radius: 12px;
      border: 1px solid var(--border);
      background: #071026;
      color: var(--muted);
    }
    .status.good { border-color: #14532d; color: var(--good); background: #07150f; }
    .status.bad { border-color: #7f1d1d; color: var(--bad); background: #150708; }

    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
      gap: 10px;
      margin-top: 12px;
    }
    .card {
      background: #0f172a;
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 12px;
    }
    .label { color: var(--muted); font-size: 12px; }
    .value { margin-top: 6px; font-size: 16px; word-break: break-word; }

    .tabs {
      display:flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 14px;
    }
    .tab {
      padding: 8px 12px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: #0a1430;
      cursor: pointer;
      user-select: none;
    }
    .tab.active {
      border-color: var(--accent);
      box-shadow: 0 0 0 1px rgba(125,211,252,.12);
    }

    .grid2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-top: 14px;
    }
    @media (max-width: 1100px) {
      .app { grid-template-columns: 1fr; }
      .sidebar { border-right: none; border-bottom: 1px solid var(--border); }
      .grid2 { grid-template-columns: 1fr; }
    }

    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 10px;
      overflow: hidden;
      border-radius: 14px;
      border: 1px solid var(--border);
      background: #0f172a;
    }
    th, td {
      padding: 10px 12px;
      border-bottom: 1px solid rgba(148,163,184,.12);
      font-size: 13px;
    }
    th { text-align:left; color: var(--muted); background: #0a1430; }
    tr:last-child td { border-bottom: none; }

    pre {
      background: #030712;
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 12px;
      max-height: 60vh;
      overflow: auto;
      line-height: 1.35;
      margin-top: 10px;
    }
    .key { color: #7dd3fc; }
    .string { color: #86efac; }
    .number { color: #fde047; }
    .boolean { color: #fca5a5; }
    .null { color: #c4b5fd; }

    .history {
      display:flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 8px;
    }
    .historyItem {
      padding: 10px 12px;
      border-radius: 12px;
      border: 1px solid var(--border);
      background: #071026;
      cursor: pointer;
      display:flex;
      align-items:center;
      justify-content: space-between;
      gap: 10px;
    }
    .historyItem:hover { border-color: var(--accent); }
    .tiny { font-size: 12px; color: var(--muted); }
    .split { display:flex; gap: 8px; align-items:center; justify-content: space-between; flex-wrap: wrap; }
  </style>
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <h1>Roblox Player Data Manager</h1>

      <h2>Lookup</h2>
      <div class="row">
        <input id="username" placeholder="Username (e.g. HaoshokuRed)" />
      </div>
      <div class="row">
        <button class="btn-primary" id="btnFetch" style="flex:1;">Fetch Player</button>
        <button id="btnCopy" style="flex:1;">Copy JSON</button>
      </div>

      <h2>Recent</h2>
      <div class="history" id="history"></div>

      <div id="sideStatus" class="status">Ready.</div>
    </aside>

    <main class="main">
      <div class="split">
        <div>
          <h1 id="title">No player loaded</h1>
          <div class="tiny" id="subtitle">Fetch a player to begin.</div>
        </div>
        <div class="row">
          <button id="btnReload">Reload</button>
        </div>
      </div>

      <div id="cards" class="cards"></div>

      <div class="tabs" id="tabs" style="display:none;"></div>

      <div class="grid2">
        <div class="card">
          <div class="label">Section View</div>
          <div id="sectionView" class="value" style="font-size:13px; margin-top:10px;">
            <div class="tiny">Pick a tab (Attributes/Combat/etc.) to render as a table.</div>
          </div>
        </div>

        <div class="card">
          <div class="label">Power mode</div>
          <div class="tiny" style="margin-top:8px;">
            This editor follows the selected tab. Save writes back to that exact section.
          </div>

          <h2 style="margin-top:14px;">JSON editor (current tab)</h2>
          <textarea id="powerJson" spellcheck="false"></textarea>

          <div class="row" style="margin-top:10px;">
            <button class="btn-primary" id="btnSave" style="flex:1;">Save</button>
            <button class="btn-danger" id="btnReset" style="flex:1;">Reset</button>
          </div>

          <div id="mainStatus" class="status" style="margin-top:10px;">No edits pending.</div>
          <div class="tiny" id="editHint" style="margin-top:8px;"></div>
        </div>
      </div>

      <div class="card" style="margin-top:14px;">
        <div class="label">JSON Output (filtered by tab)</div>
        <pre id="output">Waiting…</pre>
      </div>
    </main>
  </div>

<script>
const $ = (id) => document.getElementById(id);

let lastUsername = "";
let lastJson = null;
let lastEtag = null;
let lastEntryId = null;

// tab state
let currentTabIndex = 0;
let currentTab = null;

function setSideStatus(msg, kind="") {
  const el = $("sideStatus");
  el.className = "status" + (kind ? " " + kind : "");
  el.textContent = msg;
}
function setMainStatus(msg, kind="") {
  const el = $("mainStatus");
  el.className = "status" + (kind ? " " + kind : "");
  el.textContent = msg;
}

function syntaxHighlight(json) {
  const str = JSON.stringify(json, null, 2)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return str.replace(
    /(\\b(true|false|null)\\b)|(-?\\d+(?:\\.\\d*)?)|"(.*?)":|"([^"]*)"/g,
    (match, bool, _b, num, key, str) => {
      if (bool) return '<span class="boolean">' + bool + "</span>";
      if (num) return '<span class="number">' + num + "</span>";
      if (key) return '<span class="key">"' + key + '"</span>:';
      if (str) return '<span class="string">"' + str + '"</span>';
      return match;
    }
  );
}

function unixToLocal(ts) {
  if (!ts || typeof ts !== "number") return "—";
  return new Date(ts * 1000).toLocaleString();
}

function saveHistory(username) {
  const key = "rpdm_history";
  const cur = JSON.parse(localStorage.getItem(key) || "[]");
  const next = [username, ...cur.filter(u => u !== username)].slice(0, 20);
  localStorage.setItem(key, JSON.stringify(next));
  renderHistory();
}

function renderHistory() {
  const key = "rpdm_history";
  const list = JSON.parse(localStorage.getItem(key) || "[]");
  const root = $("history");
  root.innerHTML = "";
  if (!list.length) {
    root.innerHTML = '<div class="tiny">No recent lookups.</div>';
    return;
  }
  for (const u of list) {
    const div = document.createElement("div");
    div.className = "historyItem";
    div.innerHTML = '<span>' + u + '</span><span class="tiny">Load</span>';
    div.onclick = () => { $("username").value = u; fetchPlayer(); };
    root.appendChild(div);
  }
}

function renderCards(json) {
  const v = json?.data?.value;
  const d = v?.Data;
  const md = v?.MetaData;

  const invCount = Array.isArray(d?.Inventory) ? d.Inventory.length : "—";
  const mutCount = Array.isArray(d?.Mutations) ? d.Mutations.length : "—";

  const cards = [
    ["Username", json.username],
    ["UserId", json.userId],
    ["ProfileCreateTime", unixToLocal(md?.ProfileCreateTime)],
    ["LastUpdate", unixToLocal(md?.LastUpdate)],
  ];

  $("cards").innerHTML = cards.map(([label, value]) => \`
    <div class="card">
      <div class="label">\${label}</div>
      <div class="value">\${(value ?? "—")}</div>
    </div>
  \`).join("");
}

function toRows(obj) {
  if (!obj || typeof obj !== "object") return [];
  return Object.keys(obj).sort().map(k => [k, obj[k]]);
}

function renderTable(title, obj) {
  const rows = toRows(obj);
  if (!rows.length) return '<div class="tiny">No data</div>';

  return \`
    <div class="tiny">\${title}</div>
    <table>
      <thead><tr><th>Key</th><th>Value</th></tr></thead>
      <tbody>
        \${rows.map(([k,v]) => \`<tr><td>\${k}</td><td>\${v}</td></tr>\`).join("")}
      </tbody>
    </table>
  \`;
}

// Get payload by a path inside the *entry* object (not lastJson wrapper)
function getByPath(root, pathArr) {
  let cur = root;
  for (const k of pathArr) {
    if (!cur || typeof cur !== "object" || !(k in cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

function setPowerModeEditable(editable, hint) {
  const ta = $("powerJson");
  ta.readOnly = !editable;
  ta.style.opacity = editable ? "1" : "0.65";
  $("editHint").textContent = hint || "";
}

function setPowerModeJson(obj) {
  $("powerJson").value = JSON.stringify(obj ?? null, null, 2);
}

function activateTab(i) {
  if (!lastJson) return;

  currentTabIndex = i;

  const entry = lastJson.data;
  const value = entry?.value;
  const data = value?.Data;
  const stats = data?.Stats || {};

  const tabs = buildTabs(value, data, stats);

  currentTab = tabs[i];

  // UI active state
  const root = $("tabs");
  [...root.querySelectorAll(".tab")].forEach((el, idx) => {
    el.classList.toggle("active", idx === i);
  });

  // Update Section View / Output
  if (currentTab.kind === "table") {
    $("sectionView").innerHTML = renderTable(currentTab.title, currentTab.payload);
    $("output").innerHTML = syntaxHighlight({ section: currentTab.name, value: currentTab.payload ?? null });
  } else {
    $("sectionView").innerHTML = '<div class="tiny">Showing JSON in output pane.</div>';
    $("output").innerHTML = syntaxHighlight(currentTab.payload ?? null);
  }

  // Power Mode follows tab (worldwide filter)
  setPowerModeJson(currentTab.payload);

  // editable only if it maps to value.Data subtree (safe)
  if (currentTab.editPath) {
    setPowerModeEditable(true, "Editing path: value." + currentTab.editPath.join("."));
  } else {
    setPowerModeEditable(false, "Read-only for this tab.");
  }

  setMainStatus("Viewing: " + currentTab.name, "good");
}

function buildTabs(value, data, stats) {
  // editPath is relative to entry.value (NOT lastJson)
  // Only allow edits inside Data subtree (safe). Full/MetaData/GlobalUpdates read-only.
  return [
    { name: "Full", kind: "json", payload: lastJson, editPath: null },
    { name: "Data", kind: "json", payload: data, editPath: ["Data"] },

    { name: "Attributes", kind: "table", payload: stats.Attributes, title: "Stats.Attributes", editPath: ["Data","Stats","Attributes"] },
    { name: "Combat", kind: "table", payload: stats.Combat, title: "Stats.Combat", editPath: ["Data","Stats","Combat"] },
    { name: "Skills", kind: "table", payload: stats.Skills, title: "Stats.Skills", editPath: ["Data","Stats","Skills"] },
    { name: "Resistances", kind: "table", payload: stats.Resistances, title: "Stats.Resistances", editPath: ["Data","Stats","Resistances"] },
    { name: "Reputation", kind: "table", payload: stats.Reputation, title: "Stats.Reputation", editPath: ["Data","Stats","Reputation"] },

    // Keep these tabs because they are useful to view, but keep read-only by default
    { name: "MetaData", kind: "json", payload: value?.MetaData, editPath: null },
    { name: "GlobalUpdates", kind: "json", payload: value?.GlobalUpdates, editPath: null },
  ];
}

function renderTabs() {
  if (!lastJson) return;

  const entry = lastJson.data;
  const value = entry?.value;
  const data = value?.Data;
  const stats = data?.Stats || {};

  const tabs = buildTabs(value, data, stats);

  const root = $("tabs");
  root.style.display = "flex";
  root.innerHTML = tabs.map((t, i) => \`<div class="tab" data-i="\${i}">\${t.name}</div>\`).join("");

  root.onclick = (e) => {
    const el = e.target.closest(".tab");
    if (!el) return;
    activateTab(Number(el.dataset.i));
  };

  // default to Data
  activateTab(1);
}

function fillPowerModeFromCurrentTab() {
  if (!lastJson || !currentTab) return;
  setPowerModeJson(currentTab.payload);
  setMainStatus("Reset to loaded data for " + currentTab.name, "good");
}

// ---------- Networking ----------
async function fetchPlayer() {
  const username = $("username").value.trim();
  if (!username) return;

  setSideStatus("Loading…");
  setMainStatus("Loading…");
  $("output").textContent = "Loading…";

  try {
    const r = await fetch("/api/player/" + encodeURIComponent(username));
    const json = await r.json();
    if (!r.ok) throw new Error(json?.error || "Request failed");

    lastUsername = json.username;
    lastJson = json;
    lastEtag = json.data?.etag || null;
    lastEntryId = json.entryId;

    $("title").textContent = json.username + " (UserId " + json.userId + ")";
    $("subtitle").textContent =
      "Entry: " + json.entryId +
      " • ETag: " + (lastEtag || "—") +
      " • Revision: " + (json.data?.revisionId || "—");

    renderCards(json);
    renderTabs();

    setSideStatus("Loaded ✅", "good");
    setMainStatus("Loaded. Select a tab, edit Power Mode JSON, Save.", "good");

    saveHistory(username);
  } catch (e) {
    setSideStatus("Error: " + (e.message || "unknown"), "bad");
    setMainStatus("Error: " + (e.message || "unknown"), "bad");
    $("output").textContent = "";
  }
}

async function saveEdits() {
  if (!lastJson || !currentTab) {
    return setMainStatus("Load a player first.", "bad");
  }
  if (!currentTab.editPath) {
    return setMainStatus("This tab is read-only.", "bad");
  }

  let newObj;
  try {
    newObj = JSON.parse($("powerJson").value || "null");
  } catch {
    return setMainStatus("Power mode JSON is invalid JSON.", "bad");
  }

  // basic sanity: for the table-ish tabs, encourage object shape
  if (currentTab.kind === "table" && !(newObj === null || typeof newObj === "object")) {
    return setMainStatus("Expected an object for this section.", "bad");
  }

  setMainStatus("Saving…");

  try {
    const r = await fetch("/api/player/" + encodeURIComponent(lastUsername) + "/set-section", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedEtag: lastEtag,
        // editPath relative to entry.value
        editPath: currentTab.editPath,
        value: newObj
      }),
    });

    const json = await r.json();
    if (!r.ok) throw new Error(json?.error || "Save failed");

    setMainStatus("Saved ✅ Reloading…", "good");
    await fetchPlayer();
  } catch (e) {
    setMainStatus("Save failed: " + (e.message || "unknown"), "bad");
  }
}

// Buttons
$("btnFetch").onclick = fetchPlayer;
$("btnReload").onclick = () => fetchPlayer();
$("btnCopy").onclick = () => {
  if (!lastJson) return;
  navigator.clipboard.writeText(JSON.stringify(lastJson, null, 2));
  setMainStatus("Copied full JSON ✅", "good");
};
$("btnSave").onclick = saveEdits;
$("btnReset").onclick = fillPowerModeFromCurrentTab;

$("username").addEventListener("keydown", (e) => { if (e.key === "Enter") fetchPlayer(); });

window.addEventListener("DOMContentLoaded", () => {
  renderHistory();
  const last = localStorage.getItem("rpdm_lastUsername");
  if (last) $("username").value = last;

  // persist last username on fetch
  const originalFetch = fetchPlayer;
  fetchPlayer = async function() {
    const u = $("username").value.trim();
    if (u) localStorage.setItem("rpdm_lastUsername", u);
    return originalFetch();
  };
});
</script>
</body>
</html>`);
});

// ---------- API: Read Player ----------
app.get("/api/player/:username", async (req, res) => {
  try {
    const username = req.params.username;

    const userId = await usernameToUserId(username);
    if (!userId) return res.status(404).json({ error: "Username not found" });

    const entryId = `Player_${userId}`;
    const data = await fetchJson(entryUrl(entryId), {
      headers: { "x-api-key": ROBLOX_API_KEY },
    });

    res.json({ username, userId, entryId, data });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, details: err.details || null });
  }
});

// ---------- API: Update a specific section under entry.value (ETag protected) ----------
app.post("/api/player/:username/set-section", requireAdmin, async (req, res) => {
  try {
    const username = req.params.username;
    const { expectedEtag, editPath, value } = req.body || {};

    if (!Array.isArray(editPath) || editPath.length === 0) {
      return res.status(400).json({ error: "Body must include { editPath: [..], value: ... }" });
    }

    // Safety: only allow edits within Data subtree (value.Data...)
    if (editPath[0] !== "Data") {
      return res.status(400).json({ error: "Edits are only allowed within value.Data.*" });
    }

    const userId = await usernameToUserId(username);
    if (!userId) return res.status(404).json({ error: "Username not found" });

    const entryId = `Player_${userId}`;

    // 1) Read latest
    const current = await fetchJson(entryUrl(entryId), {
      headers: { "x-api-key": ROBLOX_API_KEY },
    });

    const currentEtag = current.etag;
    if (expectedEtag && currentEtag && expectedEtag !== currentEtag) {
      return res.status(409).json({
        error: "ETag mismatch (someone updated this entry). Reload and try again.",
        expectedEtag,
        currentEtag,
      });
    }

    // 2) Apply patch
    const newValue = isPlainObject(current.value) ? { ...current.value } : {};
    if (!isPlainObject(newValue.Data)) newValue.Data = {};

    setAtPath(newValue, editPath, value);

    const body = JSON.stringify({ value: newValue });

    // 3) Write back with If-Match
    const updated = await fetchJson(entryUrl(entryId), {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body).toString(),
        "x-api-key": ROBLOX_API_KEY,
        ...(currentEtag ? { "If-Match": currentEtag } : {}),
      },
      body,
    });

    res.json({ ok: true, entryId, updated });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, details: err.details || null });
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log("✅ Roblox Player Data Manager running");
  console.log(`🌐 http://localhost:${PORT}`);
  console.log(`❤️  http://localhost:${PORT}/health`);
});