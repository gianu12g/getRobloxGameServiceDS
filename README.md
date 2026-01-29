# getRobloxGameServiceDS

A lightweight dev tool for viewing Roblox DataStore data using **Roblox Open Cloud**.

This tool allows developers to:
- Fetch player data stored via ProfileStore
- Resolve username → UserId
- View saved data in a pretty-printed web UI
- Inspect production data safely (read-only)

## Requirements
- Node.js 18+
- Roblox Open Cloud API key with:
  - universe-datastores.objects.read
  - universe-datastores.objects.list (optional)
- GAME MUST BE PUBLISHED TO ROBLOX
 - In studio click file --> Publish to Roblox as --> Create new experience or overwrite old one.
 - Load the game, when you leave, the data should be saved and the API should be able to return info

## Setup and Configuration

First, install the project dependencies by running `npm install` from the project root.

This project is configured using environment variables, which are loaded from a `.env` file. Create a file named `.env` in the root of the project (the same directory as `server.js`). This file should never be committed to source control.

Example `.env` contents:

    ROBLOX_API_KEY = your_open_cloud_api_key_here
    UNIVERSE_ID = 9640149412
    DATASTORE_ID = PlayerData_v1

`PORT` is optional and defaults to 3000 if not provided.

## Getting a Roblox Open Cloud API Key

To generate the API key used by this tool, open the Roblox Creator Dashboard and navigate to **All tools** then **Open Cloud API** section. From there, go to **API Keys** and click **Create User API Key**. Give the key a descriptive name such as `getRobloxGameServiceDS-readonly`.

When configuring permissions, enable `universe-datastores.objects` and universe-datastore.versions `universe-datastores.objects`. Enabling `READ` and `LIST` for both

Once the key is created, copy it immediately, as Roblox will not show it again. Paste this value into your `.env` file as `ROBLOX_API_KEY`. Check server.json to see the variable names.

## Getting Your Universe ID

Open Roblox Creator Dashboard go to creations, click on your world and copy the Universe ID shown in the url(will be a number). Paste this value into the `.env` file as `ROBLOX_UNIVERSE_ID`.

## Running the Server

Start the server by running `node server.js`. Once the server is running, open your browser and navigate to http://localhost:3000 (or the port you specified) to access the web UI.

## Security Notes

This tool is strictly read-only and does not mutate DataStore data. Never expose your Open Cloud API key publicly, always scope it to the minimum required permissions and universes, and rotate the key immediately if it is ever leaked.
