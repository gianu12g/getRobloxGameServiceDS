const express = require("express");

const app = express();

// ================== CONFIG ==================
const ROBLOX_API_KEY = "";
const UNIVERSE_ID = "9640149412";
const DATASTORE_ID = "PlayerData_v1"; // must match ProfileStore.New(...)
const SCOPE = "global";
// ============================================

if (!ROBLOX_API_KEY || ROBLOX_API_KEY.includes("PASTE")) {
  console.error("❌ ERROR: Paste your Open Cloud API key into server.js");
  process.exit(1);
}

// ---------- Utility ----------
async function fetchJson(url, options = {}) {
  const r = await fetch(url, options);
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
    throw err;
  }

  return json;
}

// ---------- Health ----------
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// ---------- Pretty Viewer (HTML) ----------
app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Roblox Player Data Viewer</title>
  <style>
    body {
      font-family: monospace;
      background: #0f172a;
      color: #e5e7eb;
      padding: 20px;
    }
    input, button {
      padding: 8px;
      font-size: 14px;
    }
    button { cursor: pointer; }
    pre {
      background: #020617;
      padding: 16px;
      margin-top: 16px;
      border-radius: 6px;
      max-height: 70vh;
      overflow: auto;
    }
    .key { color: #7dd3fc; }
    .string { color: #86efac; }
    .number { color: #fde047; }
    .boolean { color: #fca5a5; }
    .null { color: #c4b5fd; }
  </style>
</head>
<body>
  <h2>Roblox Player Data Viewer</h2>

  <input id="username" placeholder="Username (e.g. HaoshokuRed)" />
  <button onclick="loadData()">Fetch</button>

  <pre id="output">Waiting...</pre>

<script>
function syntaxHighlight(json) {
  json = JSON.stringify(json, null, 2)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return json.replace(
    /(\\b(true|false|null)\\b)|(-?\\d+(?:\\.\\d*)?)|"(.*?)":|"([^"]*)"/g,
    function(match, bool, _, num, key, str) {
      if (bool) return '<span class="boolean">' + bool + '</span>';
      if (num) return '<span class="number">' + num + '</span>';
      if (key) return '<span class="key">"' + key + '"</span>:';
      if (str) return '<span class="string">"' + str + '"</span>';
      return match;
    }
  );
}

async function loadData() {
  const username = document.getElementById("username").value.trim();
  if (!username) return;

  const out = document.getElementById("output");
  out.textContent = "Loading...";

  try {
    const res = await fetch("/player-by-username/" + username);
    const json = await res.json();
    out.innerHTML = syntaxHighlight(json);
  } catch (e) {
    out.textContent = "Error loading data";
  }
}
</script>
</body>
</html>
`);
});

// ---------- Username → UserId → Open Cloud ----------
app.get("/player-by-username/:username", async (req, res) => {
  try {
    const username = req.params.username;

    // 1) Username → UserId
    const userLookup = await fetchJson(
      "https://users.roblox.com/v1/usernames/users",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          usernames: [username],
          excludeBannedUsers: false,
        }),
      }
    );

    if (!userLookup.data || userLookup.data.length === 0) {
      return res.status(404).json({ error: "Username not found" });
    }

    const userId = userLookup.data[0].id;
    const entryId = `Player_${userId}`;

    // 2) Fetch from Open Cloud DataStore
    const url =
      `https://apis.roblox.com/cloud/v2/universes/${encodeURIComponent(UNIVERSE_ID)}` +
      `/data-stores/${encodeURIComponent(DATASTORE_ID)}` +
      `/scopes/${encodeURIComponent(SCOPE)}` +
      `/entries/${encodeURIComponent(entryId)}`;

    const data = await fetchJson(url, {
      headers: { "x-api-key": ROBLOX_API_KEY },
    });

    res.json({
      username,
      userId,
      entryId,
      data,
    });
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.message,
      details: err.details || null,
    });
  }
});

// ---------- Start Server ----------
app.listen(3000, () => {
  console.log("✅ Roblox Open Cloud Viewer running");
  console.log("🌐 http://localhost:3000");
  console.log("❤️  http://localhost:3000/health");
});