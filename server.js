/**
 * Roblox Player Data Manager (Open Cloud Data Stores v2)
 * - Game tabs with datastore sub-tabs
 * - Per-game API keys and universe IDs
 * - Raw JSON display + editor
 * - Configurable entry key templates
 * - Purge player data across all datastores for a game
 * - Safe updates with ETag (If-Match)
 *
 * Node 18+ recommended (built-in fetch).
 */

require("dotenv").config();

const express = require("express");
const app = express();

app.use(express.json({ limit: "2mb" }));

// ================== CONFIG ==================
const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

// Parse GAME_* entries: GAME_1="Name|Universe ID|API Key|Max Slots"
function parseGames() {
  const games = new Map();
  for (const [key, val] of Object.entries(process.env)) {
    if (/^GAME_\d+$/.test(key) && val) {
      const parts = val.split("|").map((s) => s.trim());
      if (parts.length >= 3) {
        const num = key.split("_")[1];
        games.set(num, {
          num,
          name: parts[0],
          universeId: parts[1],
          apiKey: parts[2],
          maxSlots: parseInt(parts[3]) || 1,
          stores: [],
        });
      }
    }
  }
  return games;
}

// Parse DATASTORE_* entries: DATASTORE_1="Game Number|Store Label|DataStore Name|Scope|Key Template"
function parseDatastores(gamesMap) {
  const stores = [];
  for (const [key, val] of Object.entries(process.env)) {
    if (/^DATASTORE_\d+$/.test(key) && val) {
      const parts = val.split("|").map((s) => s.trim());
      if (parts.length >= 3) {
        const gameNum = parts[0];
        const game = gamesMap.get(gameNum);
        if (!game) {
          console.warn(`${key} references GAME_${gameNum} which doesn't exist, skipping.`);
          continue;
        }

        const keyTemplate = parts[4] || "Player_{userId}";
        const extraParams = [];
        const paramRegex = /\{(\w+)\}/g;
        let m;
        while ((m = paramRegex.exec(keyTemplate)) !== null) {
          if (m[1] !== "userId") extraParams.push(m[1]);
        }

        const store = {
          id: key,
          gameNum,
          storeLabel: parts[1],
          datastoreId: parts[2],
          scope: parts[3] || "global",
          keyTemplate,
          extraParams,
        };

        stores.push(store);
        game.stores.push(store);
      }
    }
  }
  // Sort by numeric suffix
  stores.sort((a, b) => {
    const numA = parseInt(a.id.split("_")[1]);
    const numB = parseInt(b.id.split("_")[1]);
    return numA - numB;
  });
  return stores;
}

const GAMES_MAP = parseGames();
const ALL_STORES = parseDatastores(GAMES_MAP);
const GAMES = [...GAMES_MAP.values()].sort((a, b) => parseInt(a.num) - parseInt(b.num));

if (GAMES.length === 0) {
  console.error("No GAME_* entries found in .env. Add at least one.");
  console.error('Format: GAME_1="Name|UniverseId|ApiKey"');
  process.exit(1);
}
if (ALL_STORES.length === 0) {
  console.error("No DATASTORE_* entries found in .env. Add at least one.");
  console.error('Format: DATASTORE_1="GameNumber|StoreLabel|DataStoreName|Scope|KeyTemplate"');
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

function entryUrl(universeId, datastoreId, scope, entryId) {
  return (
    `https://apis.roblox.com/cloud/v2/universes/${encodeURIComponent(universeId)}` +
    `/data-stores/${encodeURIComponent(datastoreId)}` +
    `/scopes/${encodeURIComponent(scope)}` +
    `/entries/${encodeURIComponent(entryId)}`
  );
}

function buildEntryKey(template, userId, extras = {}) {
  let key = template.replace("{userId}", userId);
  for (const [k, v] of Object.entries(extras)) {
    key = key.replace(`{${k}}`, v);
  }
  const unresolved = key.match(/\{(\w+)\}/);
  if (unresolved) {
    throw new Error(`Missing parameter: ${unresolved[1]}`);
  }
  return key;
}

// For purge: expand all possible keys for a store template
// e.g. "Account_{userId}_Slot_{slot}" with maxSlots=3 -> 3 keys
function expandAllKeys(template, userId, maxSlots) {
  const params = [];
  const paramRegex = /\{(\w+)\}/g;
  let m;
  while ((m = paramRegex.exec(template)) !== null) {
    if (m[1] !== "userId") params.push(m[1]);
  }

  if (params.length === 0) {
    return [buildEntryKey(template, userId)];
  }

  const keys = [];
  for (let i = 1; i <= maxSlots; i++) {
    const extras = {};
    for (const p of params) extras[p] = String(i);
    keys.push(buildEntryKey(template, userId, extras));
  }
  return keys;
}

// DELETE helper — doesn't expect JSON body back, just checks status
async function deleteEntry(url, apiKey, { timeoutMs = 10000, retries = 2 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const r = await fetch(url, {
        method: "DELETE",
        headers: { "x-api-key": apiKey },
        signal: controller.signal,
      });

      if (r.ok || r.status === 204) {
        return { ok: true, status: r.status };
      }

      // 404 means entry doesn't exist — not an error for purge
      if (r.status === 404) {
        return { ok: true, status: 404, skipped: true };
      }

      if ((r.status === 429 || r.status >= 500) && attempt < retries) {
        const backoff = 250 * Math.pow(2, attempt);
        await new Promise((s) => setTimeout(s, backoff));
        continue;
      }

      const text = await r.text();
      let details;
      try { details = JSON.parse(text); } catch { details = { raw: text }; }
      return { ok: false, status: r.status, error: `HTTP ${r.status}`, details };
    } finally {
      clearTimeout(t);
    }
  }
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

function getStoreConfig(dsId) {
  return ALL_STORES.find((d) => d.id === dsId) || null;
}

function getGameForStore(store) {
  return GAMES_MAP.get(store.gameNum) || null;
}

// ---------- Health ----------
app.get("/health", (req, res) => res.json({ ok: true }));

// ---------- API: List config (no API keys exposed) ----------
app.get("/api/config", (req, res) => {
  res.json({
    games: GAMES.map((g) => ({
      num: g.num,
      name: g.name,
      universeId: g.universeId,
      maxSlots: g.maxSlots,
      stores: g.stores.map((s) => ({
        id: s.id,
        storeLabel: s.storeLabel,
        datastoreId: s.datastoreId,
        scope: s.scope,
        keyTemplate: s.keyTemplate,
        extraParams: s.extraParams,
      })),
    })),
  });
});

// ---------- API: Read Player ----------
app.get("/api/player/:username", async (req, res) => {
  try {
    const username = req.params.username;
    const dsId = req.query.ds;

    const store = getStoreConfig(dsId);
    if (!store) return res.status(400).json({ error: "Invalid datastore selection" });

    const game = getGameForStore(store);
    if (!game) return res.status(400).json({ error: "Game not found for store" });

    const userId = await usernameToUserId(username);
    if (!userId) return res.status(404).json({ error: "Username not found" });

    const extras = {};
    for (const p of store.extraParams) {
      if (req.query[p]) extras[p] = req.query[p];
    }

    const entryId = buildEntryKey(store.keyTemplate, userId, extras);
    const data = await fetchJson(
      entryUrl(game.universeId, store.datastoreId, store.scope, entryId),
      { headers: { "x-api-key": game.apiKey } }
    );

    res.json({
      username,
      userId,
      entryId,
      data,
      game: game.name,
      store: store.storeLabel,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, details: err.details || null });
  }
});

// ---------- API: Update full value (ETag protected) ----------
app.post("/api/player/:username/update", requireAdmin, async (req, res) => {
  try {
    const username = req.params.username;
    const dsId = req.query.ds;
    const { expectedEtag, value } = req.body || {};

    const store = getStoreConfig(dsId);
    if (!store) return res.status(400).json({ error: "Invalid datastore selection" });

    const game = getGameForStore(store);
    if (!game) return res.status(400).json({ error: "Game not found for store" });

    if (value === undefined) {
      return res.status(400).json({ error: "Body must include { value: ... }" });
    }

    const userId = await usernameToUserId(username);
    if (!userId) return res.status(404).json({ error: "Username not found" });

    const extras = {};
    for (const p of store.extraParams) {
      if (req.query[p]) extras[p] = req.query[p];
    }

    const entryId = buildEntryKey(store.keyTemplate, userId, extras);
    const url = entryUrl(game.universeId, store.datastoreId, store.scope, entryId);

    const current = await fetchJson(url, {
      headers: { "x-api-key": game.apiKey },
    });

    const currentEtag = current.etag;
    if (expectedEtag && currentEtag && expectedEtag !== currentEtag) {
      return res.status(409).json({
        error: "ETag mismatch (data was modified externally). Reload and try again.",
        expectedEtag,
        currentEtag,
      });
    }

    const body = JSON.stringify({ value });

    const updated = await fetchJson(url, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body).toString(),
        "x-api-key": game.apiKey,
        ...(currentEtag ? { "If-Match": currentEtag } : {}),
      },
      body,
    });

    res.json({ ok: true, entryId, updated });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, details: err.details || null });
  }
});

// ---------- API: Purge all data for a player across all datastores in a game ----------
app.post("/api/purge/:username", requireAdmin, async (req, res) => {
  try {
    const username = req.params.username;
    const gameNum = req.query.game;

    const game = GAMES_MAP.get(gameNum);
    if (!game) return res.status(400).json({ error: "Invalid game selection" });

    if (!game.stores.length) {
      return res.status(400).json({ error: "No datastores configured for this game" });
    }

    const userId = await usernameToUserId(username);
    if (!userId) return res.status(404).json({ error: "Username not found" });

    const results = [];

    for (const store of game.stores) {
      const keys = expandAllKeys(store.keyTemplate, userId, game.maxSlots);

      for (const entryId of keys) {
        const url = entryUrl(game.universeId, store.datastoreId, store.scope, entryId);
        const result = await deleteEntry(url, game.apiKey);

        results.push({
          store: store.storeLabel,
          datastoreId: store.datastoreId,
          entryId,
          ...result,
        });
      }
    }

    const deleted = results.filter((r) => r.ok && !r.skipped).length;
    const skipped = results.filter((r) => r.ok && r.skipped).length;
    const failed = results.filter((r) => !r.ok).length;

    res.json({
      ok: failed === 0,
      username,
      userId,
      game: game.name,
      summary: { deleted, skipped, failed, total: results.length },
      results,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, details: err.details || null });
  }
});

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
      --bg: #070b14;
      --bg2: #0b1220;
      --surface: #0f172a;
      --border: #1f2a44;
      --text: #e5e7eb;
      --muted: #94a3b8;
      --accent: #7dd3fc;
      --good: #86efac;
      --bad: #fecaca;
    }
    * { box-sizing: border-box; margin: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }

    /* Top bar with game tabs */
    .topbar {
      background: #050812;
      border-bottom: 1px solid var(--border);
      padding: 0 20px;
      display: flex;
      align-items: stretch;
    }
    #gameTabs { display: flex; align-items: stretch; }
    #storeTabs { display: flex; align-items: stretch; }
    .topbar-title {
      font-size: 14px;
      padding: 12px 16px 12px 0;
      border-right: 1px solid var(--border);
      margin-right: 4px;
      display: flex;
      align-items: center;
      white-space: nowrap;
    }
    .game-tab {
      padding: 12px 18px;
      cursor: pointer;
      font-size: 13px;
      color: var(--muted);
      border-bottom: 2px solid transparent;
      transition: color 0.15s, border-color 0.15s;
      user-select: none;
    }
    .game-tab:hover { color: var(--text); }
    .game-tab.active {
      color: var(--accent);
      border-bottom-color: var(--accent);
    }

    /* Sub-tabs (datastores) */
    .subtabs {
      background: #0a0e1a;
      border-bottom: 1px solid var(--border);
      padding: 0 20px;
      display: flex;
      align-items: stretch;
    }
    .store-tab {
      padding: 10px 16px;
      cursor: pointer;
      font-size: 12px;
      color: var(--muted);
      border-bottom: 2px solid transparent;
      transition: color 0.15s, border-color 0.15s;
      user-select: none;
    }
    .store-tab:hover { color: var(--text); }
    .store-tab.active {
      color: var(--good);
      border-bottom-color: var(--good);
    }
    .store-tab .store-key {
      font-size: 11px;
      color: var(--muted);
      opacity: 0.6;
      margin-left: 6px;
    }

    /* Layout */
    .layout {
      display: grid;
      grid-template-columns: 280px 1fr;
      min-height: calc(100vh - 84px);
    }

    /* Sidebar */
    .sidebar {
      background: #050812;
      border-right: 1px solid var(--border);
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .sidebar h2 {
      font-size: 12px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: .04em;
      margin-top: 10px;
    }

    /* Form controls */
    input, button, textarea {
      background: var(--bg2);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 9px 11px;
      font-size: 13px;
      font-family: inherit;
      outline: none;
      width: 100%;
    }
    button { cursor: pointer; width: auto; }
    button:hover { border-color: var(--accent); }
    textarea {
      resize: vertical;
      line-height: 1.4;
      min-height: 300px;
      tab-size: 2;
    }

    .btn-row { display: flex; gap: 8px; margin-top: 6px; }
    .btn-row button { flex: 1; }
    .btn-primary { border-color: #2b4a67; }
    .btn-danger { border-color: #7f1d1d; }
    .btn-danger:hover { border-color: #ef4444; }

    /* Status */
    .status {
      padding: 9px 11px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--bg2);
      color: var(--muted);
      font-size: 12px;
      margin-top: 6px;
    }
    .status.good { border-color: #14532d; color: var(--good); background: #07150f; }
    .status.bad { border-color: #7f1d1d; color: var(--bad); background: #150708; }

    /* Main */
    .main {
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      overflow: hidden;
    }
    .player-header {
      display: flex;
      align-items: baseline;
      gap: 12px;
      flex-wrap: wrap;
    }
    .player-header h1 { font-size: 16px; }
    .player-header .meta { font-size: 12px; color: var(--muted); }

    /* Two-pane layout */
    .panes {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
      flex: 1;
      min-height: 0;
    }
    .pane {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px;
      display: flex;
      flex-direction: column;
      min-height: 0;
      overflow: hidden;
    }
    .pane-label {
      font-size: 12px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: .04em;
      margin-bottom: 10px;
      flex-shrink: 0;
    }

    /* JSON display */
    pre.json {
      background: #030712;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      overflow: auto;
      line-height: 1.35;
      font-size: 13px;
      flex: 1;
      min-height: 0;
    }
    .key { color: #7dd3fc; }
    .string { color: #86efac; }
    .number { color: #fde047; }
    .boolean { color: #fca5a5; }
    .null { color: #c4b5fd; }

    /* Editor pane */
    .editor-wrap {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    .editor-wrap textarea { flex: 1; }

    /* Extra param inputs */
    #extraParams { display: flex; flex-direction: column; gap: 6px; }
    #extraParams:empty { display: none; }

    /* History */
    .history { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
    .historyItem {
      padding: 8px 10px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--bg2);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 13px;
    }
    .historyItem:hover { border-color: var(--accent); }
    .tiny { font-size: 12px; color: var(--muted); }

    /* Purge confirmation overlay */
    .overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.75);
      z-index: 100;
      align-items: center;
      justify-content: center;
    }
    .overlay.show { display: flex; }
    .overlay-box {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 24px;
      max-width: 480px;
      width: 90%;
    }
    .overlay-box h2 { font-size: 16px; color: var(--bad); margin-bottom: 12px; }
    .overlay-box p { font-size: 13px; color: var(--muted); margin-bottom: 8px; line-height: 1.5; }
    .overlay-box .warn { color: var(--bad); font-size: 12px; margin-bottom: 14px; }
    .overlay-box .btn-row { margin-top: 16px; }
    .purge-log {
      background: #030712;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px;
      font-size: 12px;
      max-height: 200px;
      overflow: auto;
      margin-top: 10px;
      display: none;
      line-height: 1.6;
    }
    .purge-log.show { display: block; }
    .purge-log .del { color: var(--bad); }
    .purge-log .skip { color: var(--muted); }
    .purge-log .ok { color: var(--good); }
    .purge-log .fail { color: #f87171; }

    @media (max-width: 900px) {
      .layout { grid-template-columns: 1fr; }
      .sidebar { border-right: none; border-bottom: 1px solid var(--border); }
      .panes { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>

  <div class="topbar">
    <div class="topbar-title">Player Data Manager</div>
    <div id="gameTabs"></div>
  </div>

  <div class="subtabs" id="storeTabs"></div>

  <div class="layout">
    <aside class="sidebar">
      <h2>Lookup</h2>
      <input id="username" placeholder="Username" />
      <div id="extraParams"></div>
      <div class="btn-row">
        <button class="btn-primary" id="btnFetch">Fetch</button>
        <button id="btnCopy">Copy JSON</button>
      </div>

      <h2>Recent</h2>
      <div class="history" id="history"></div>

      <h2>Danger Zone</h2>
      <button class="btn-danger" id="btnPurge" style="width:100%;">Purge Player From Game</button>

      <div style="flex:1;"></div>
      <div id="sideStatus" class="status">Ready.</div>
    </aside>

    <main class="main">
      <div class="player-header">
        <h1 id="title">No player loaded</h1>
        <span class="meta" id="subtitle"></span>
        <div style="flex:1;"></div>
        <button id="btnReload" style="width:auto;">Reload</button>
      </div>

      <div class="panes">
        <div class="pane">
          <div class="pane-label">Raw Data (read-only)</div>
          <pre class="json" id="output">Fetch a player to view their data.</pre>
        </div>

        <div class="pane">
          <div class="pane-label">Editor</div>
          <div class="editor-wrap">
            <textarea id="editor" spellcheck="false" placeholder="Fetch a player to start editing..."></textarea>
            <div class="btn-row" style="margin-top:10px;">
              <button class="btn-primary" id="btnSave">Save</button>
              <button class="btn-danger" id="btnReset">Reset</button>
            </div>
            <div id="mainStatus" class="status">No data loaded.</div>
          </div>
        </div>
      </div>
    </main>
  </div>

  <!-- Purge confirmation overlay -->
  <div class="overlay" id="purgeOverlay">
    <div class="overlay-box">
      <h2>Purge Player Data</h2>
      <p id="purgeDesc"></p>
      <p class="warn">This will permanently DELETE all entries for this player across every datastore in this game. This cannot be undone.</p>
      <div class="btn-row">
        <button class="btn-danger" id="btnConfirmPurge" style="flex:1;">Confirm Purge</button>
        <button id="btnCancelPurge" style="flex:1;">Cancel</button>
      </div>
      <div class="purge-log" id="purgeLog"></div>
    </div>
  </div>

<script>
const $ = (id) => document.getElementById(id);

let config = { games: [] };
let currentGameIdx = 0;
let currentStoreIdx = 0;
let currentStore = null;

let lastUsername = "";
let lastJson = null;
let lastEtag = null;
let lastEntryId = null;

function setSideStatus(msg, kind = "") {
  const el = $("sideStatus");
  el.className = "status" + (kind ? " " + kind : "");
  el.textContent = msg;
}
function setMainStatus(msg, kind = "") {
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
      if (key) return '<span class="key">\\"' + key + '\\"</span>:';
      if (str) return '<span class="string">\\"' + str + '\\"</span>';
      return match;
    }
  );
}

// ---- Extra params ----
function getExtraParams() {
  if (!currentStore) return {};
  const params = {};
  for (const p of currentStore.extraParams) {
    const input = document.querySelector('[data-param="' + p + '"]');
    if (input && input.value.trim()) params[p] = input.value.trim();
  }
  return params;
}

function buildQuery() {
  const params = new URLSearchParams({ ds: currentStore.id });
  const extras = getExtraParams();
  for (const [k, v] of Object.entries(extras)) params.set(k, v);
  return params.toString();
}

// ---- Tabs ----
function renderGameTabs() {
  const container = $("gameTabs");
  container.innerHTML = "";
  config.games.forEach((game, i) => {
    const tab = document.createElement("div");
    tab.className = "game-tab" + (i === currentGameIdx ? " active" : "");
    tab.textContent = game.name;
    tab.onclick = () => selectGame(i);
    container.appendChild(tab);
  });
}

function renderStoreTabs() {
  const container = $("storeTabs");
  container.innerHTML = "";
  if (!config.games.length) return;

  const game = config.games[currentGameIdx];
  game.stores.forEach((store, i) => {
    const tab = document.createElement("div");
    tab.className = "store-tab" + (i === currentStoreIdx ? " active" : "");
    tab.innerHTML = store.storeLabel + '<span class="store-key">' + store.keyTemplate + '</span>';
    tab.onclick = () => selectStore(i);
    container.appendChild(tab);
  });
}

function selectGame(idx) {
  currentGameIdx = idx;
  currentStoreIdx = 0;
  renderGameTabs();
  renderStoreTabs();
  applyStoreSelection();
  localStorage.setItem("rpdm_gameIdx", idx);
}

function selectStore(idx) {
  currentStoreIdx = idx;
  renderStoreTabs();
  applyStoreSelection();
  localStorage.setItem("rpdm_storeIdx_" + currentGameIdx, idx);
}

function applyStoreSelection() {
  if (!config.games.length) return;
  const game = config.games[currentGameIdx];
  currentStore = game.stores[currentStoreIdx] || game.stores[0];

  // Render extra param inputs
  const container = $("extraParams");
  container.innerHTML = "";
  for (const p of currentStore.extraParams) {
    const input = document.createElement("input");
    input.placeholder = p.charAt(0).toUpperCase() + p.slice(1);
    input.dataset.param = p;
    const saved = localStorage.getItem("rpdm_param_" + p);
    if (saved) input.value = saved;
    input.addEventListener("input", () => localStorage.setItem("rpdm_param_" + p, input.value));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") fetchPlayer(); });
    container.appendChild(input);
  }

  renderHistory();

  // Clear loaded data
  lastJson = null;
  lastEtag = null;
  lastEntryId = null;
  $("title").textContent = "No player loaded";
  $("subtitle").textContent = "";
  $("output").textContent = "Fetch a player to view their data.";
  $("editor").value = "";
  setMainStatus("No data loaded.");
}

// ---- History ----
function historyKey() {
  return "rpdm_history_" + (currentStore?.id || "default");
}

function saveHistory(username, extras) {
  const label = extras && Object.keys(extras).length
    ? username + " [" + Object.entries(extras).map(([k,v]) => k + "=" + v).join(", ") + "]"
    : username;

  const cur = JSON.parse(localStorage.getItem(historyKey()) || "[]");
  const entry = { label, username, extras: extras || {} };
  const next = [entry, ...cur.filter(e => e.label !== label)].slice(0, 20);
  localStorage.setItem(historyKey(), JSON.stringify(next));
  renderHistory();
}

function renderHistory() {
  const list = JSON.parse(localStorage.getItem(historyKey()) || "[]");
  const root = $("history");
  root.innerHTML = "";
  if (!list.length) {
    root.innerHTML = '<div class="tiny">No recent lookups.</div>';
    return;
  }
  for (const entry of list) {
    const label = typeof entry === "string" ? entry : entry.label;
    const username = typeof entry === "string" ? entry : entry.username;
    const extras = typeof entry === "string" ? {} : (entry.extras || {});

    const div = document.createElement("div");
    div.className = "historyItem";
    div.innerHTML = '<span>' + label + '</span><span class="tiny">Load</span>';
    div.onclick = () => {
      $("username").value = username;
      for (const [k, v] of Object.entries(extras)) {
        const input = document.querySelector('[data-param="' + k + '"]');
        if (input) input.value = v;
      }
      fetchPlayer();
    };
    root.appendChild(div);
  }
}

// ---- Display ----
function displayData(json) {
  const data = json.data;

  $("title").textContent = json.username + " (" + json.userId + ")";
  $("subtitle").textContent =
    json.game + " > " + json.store +
    " | Entry: " + json.entryId +
    " | ETag: " + (data?.etag || "-");

  $("output").innerHTML = syntaxHighlight(data?.value ?? null);
  $("editor").value = JSON.stringify(data?.value ?? null, null, 2);
  $("editor").readOnly = false;
}

// ---- Fetch ----
async function fetchPlayer() {
  const username = $("username").value.trim();
  if (!username) return;
  if (!currentStore) return setSideStatus("Select a datastore first.", "bad");

  const extras = getExtraParams();
  for (const p of (currentStore.extraParams || [])) {
    if (!extras[p]) return setSideStatus("Missing: " + p, "bad");
  }

  setSideStatus("Loading...");
  setMainStatus("Loading...");
  $("output").textContent = "Loading...";

  try {
    const r = await fetch("/api/player/" + encodeURIComponent(username) + "?" + buildQuery());
    const json = await r.json();
    if (!r.ok) throw new Error(json?.error || "Request failed");

    lastUsername = json.username;
    lastJson = json;
    lastEtag = json.data?.etag || null;
    lastEntryId = json.entryId;

    displayData(json);
    setSideStatus("Loaded", "good");
    setMainStatus("Edit the JSON on the right and hit Save.", "good");
    saveHistory(username, extras);
    localStorage.setItem("rpdm_lastUsername", username);
  } catch (e) {
    setSideStatus("Error: " + (e.message || "unknown"), "bad");
    setMainStatus("Error: " + (e.message || "unknown"), "bad");
    $("output").textContent = "";
  }
}

// ---- Save ----
async function saveEdits() {
  if (!lastJson) return setMainStatus("Load a player first.", "bad");

  let newValue;
  try {
    newValue = JSON.parse($("editor").value || "null");
  } catch {
    return setMainStatus("Invalid JSON in editor.", "bad");
  }

  setMainStatus("Saving...");

  try {
    const r = await fetch(
      "/api/player/" + encodeURIComponent(lastUsername) + "/update?" + buildQuery(),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedEtag: lastEtag, value: newValue }),
      }
    );

    const json = await r.json();
    if (!r.ok) throw new Error(json?.error || "Save failed");

    setMainStatus("Saved. Reloading...", "good");
    await fetchPlayer();
  } catch (e) {
    setMainStatus("Save failed: " + (e.message || "unknown"), "bad");
  }
}

// ---- Purge ----
function openPurgeDialog() {
  const username = $("username").value.trim();
  if (!username) return setSideStatus("Enter a username first.", "bad");
  if (!config.games.length) return;

  const game = config.games[currentGameIdx];
  const storeList = game.stores.map(s => s.storeLabel).join(", ");

  $("purgeDesc").textContent =
    'Delete ALL data for "' + username + '" from ' + game.name +
    " (" + storeList + ").";

  $("purgeLog").innerHTML = "";
  $("purgeLog").className = "purge-log";
  $("btnConfirmPurge").disabled = false;
  $("btnConfirmPurge").textContent = "Confirm Purge";
  $("btnConfirmPurge").onclick = executePurge;
  $("purgeOverlay").className = "overlay show";
}

function closePurgeDialog() {
  $("purgeOverlay").className = "overlay";
}

async function executePurge() {
  const username = $("username").value.trim();
  if (!username) return;

  const game = config.games[currentGameIdx];
  const log = $("purgeLog");
  log.innerHTML = "";
  log.className = "purge-log show";

  $("btnConfirmPurge").disabled = true;
  $("btnConfirmPurge").textContent = "Purging...";

  function addLog(cls, msg) {
    log.innerHTML += '<div class="' + cls + '">' + msg + '</div>';
    log.scrollTop = log.scrollHeight;
  }

  addLog("ok", "Starting purge for " + username + " on " + game.name + "...");

  try {
    const r = await fetch(
      "/api/purge/" + encodeURIComponent(username) + "?game=" + encodeURIComponent(game.num),
      { method: "POST", headers: { "Content-Type": "application/json" } }
    );
    const json = await r.json();

    if (!r.ok) {
      addLog("fail", "Error: " + (json.error || "Request failed"));
      $("btnConfirmPurge").textContent = "Failed";
      return;
    }

    // Log each result
    for (const res of json.results) {
      if (!res.ok) {
        addLog("fail", "FAILED " + res.store + " / " + res.entryId + " — " + (res.error || "unknown"));
      } else if (res.skipped) {
        addLog("skip", "SKIP " + res.store + " / " + res.entryId + " (not found)");
      } else {
        addLog("del", "DELETED " + res.store + " / " + res.entryId);
      }
    }

    const s = json.summary;
    addLog("ok", "Done. Deleted: " + s.deleted + ", Skipped: " + s.skipped + ", Failed: " + s.failed);

    $("btnConfirmPurge").disabled = false;
    $("btnConfirmPurge").textContent = s.failed > 0 ? "Completed with errors" : "Done";
    $("btnConfirmPurge").onclick = closePurgeDialog;

    // Clear loaded data since it's gone
    if (s.failed === 0) {
      lastJson = null;
      lastEtag = null;
      lastEntryId = null;
      $("title").textContent = "No player loaded";
      $("subtitle").textContent = "";
      $("output").textContent = "Player data purged.";
      $("editor").value = "";
      setMainStatus("Player data purged.", "good");
      setSideStatus("Purge complete", "good");
    }
  } catch (e) {
    addLog("fail", "Network error: " + (e.message || "unknown"));
    $("btnConfirmPurge").textContent = "Failed";
  }
}

$("btnPurge").onclick = openPurgeDialog;
$("btnCancelPurge").onclick = closePurgeDialog;
$("btnConfirmPurge").onclick = executePurge;
$("purgeOverlay").onclick = (e) => { if (e.target === $("purgeOverlay")) closePurgeDialog(); };

// ---- Buttons ----
$("btnFetch").onclick = fetchPlayer;
$("btnReload").onclick = fetchPlayer;
$("btnCopy").onclick = () => {
  if (!lastJson) return;
  navigator.clipboard.writeText(JSON.stringify(lastJson.data?.value ?? null, null, 2));
  setSideStatus("Copied JSON", "good");
};
$("btnSave").onclick = saveEdits;
$("btnReset").onclick = () => {
  if (!lastJson) return;
  $("editor").value = JSON.stringify(lastJson.data?.value ?? null, null, 2);
  setMainStatus("Reset to last loaded data.", "good");
};

$("username").addEventListener("keydown", (e) => { if (e.key === "Enter") fetchPlayer(); });

// ---- Init ----
window.addEventListener("DOMContentLoaded", async () => {
  try {
    const r = await fetch("/api/config");
    config = await r.json();
  } catch {
    setSideStatus("Failed to load config", "bad");
    return;
  }

  const savedGame = parseInt(localStorage.getItem("rpdm_gameIdx") || "0");
  currentGameIdx = savedGame < config.games.length ? savedGame : 0;
  const savedStore = parseInt(localStorage.getItem("rpdm_storeIdx_" + currentGameIdx) || "0");
  currentStoreIdx = savedStore < (config.games[currentGameIdx]?.stores.length || 0) ? savedStore : 0;

  renderGameTabs();
  renderStoreTabs();
  applyStoreSelection();

  const lastUser = localStorage.getItem("rpdm_lastUsername");
  if (lastUser) $("username").value = lastUser;
});
</script>
</body>
</html>`);
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log("Roblox Player Data Manager running on http://localhost:" + PORT);
  for (const g of GAMES) {
    console.log("  " + g.name + " (" + g.universeId + "): " + g.stores.map((s) => s.storeLabel).join(", "));
  }
});
