# getRobloxGameServiceDS

A lightweight dev tool for viewing Roblox DataStore data using **Open Cloud**.

This tool allows developers to:
- Fetch player data stored via ProfileStore
- Resolve username → UserId
- View saved data in a pretty-printed web UI
- Inspect production data safely (read-only)

---

## Requirements
- Node.js 18+
- Roblox Open Cloud API key with:
  - universe-datastores.objects.read
  - universe-datastores.objects.list (optional)

---

## Setup

```bash
npm install
node server.js
