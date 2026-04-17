# WHOOP MCP Server - Complete Setup Guide & Lessons Learned

## Overview

This is a Model Context Protocol (MCP) server that connects Claude (Desktop or Code) to the WHOOP fitness API. It lets you ask Claude for your recovery scores, HRV, sleep data, workouts, and more by voice or text.

**Server location:** `C:\Users\Pkenn\whoop-mcp-server-claude\`
**Entry point:** `dist/index.js` (compiled from `src/index.ts`)

---

## Architecture

```
Claude Desktop/Code
    |
    | (stdio - JSON-RPC)
    |
WHOOP MCP Server (Node.js)
    |
    | (HTTPS + OAuth Bearer token)
    |
WHOOP Developer API v2
    https://api.prod.whoop.com/developer/v2/
```

**Key files:**
| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point - loads env vars, starts server |
| `src/mcp-server.ts` | MCP tool definitions, OAuth flow, token management |
| `src/whoop-api.ts` | WHOOP API client (all endpoint methods) |
| `src/types.ts` | TypeScript interfaces for API responses |
| `.env` | Client ID, client secret, redirect URI |
| `whoop-tokens.json` | Saved OAuth tokens (auto-created after first auth) |

---

## How Authentication Works

1. You call the `authorize_whoop` tool (or Claude calls it for you)
2. The server starts a local HTTP listener on port 3001
3. You open the WHOOP OAuth URL in your browser and log in
4. WHOOP redirects back to `localhost:3001/oauth/callback` with an auth code
5. The server exchanges the code for access + refresh tokens
6. Tokens are saved to `whoop-tokens.json` for future sessions

**Token lifecycle:**
- Access tokens expire after ~2 weeks
- Refresh tokens are long-lived
- On startup, the server loads saved tokens and auto-refreshes if expired
- You should rarely need to re-authorize manually

---

## WHOOP API Endpoints (v2)

**Base URL:** `https://api.prod.whoop.com/developer/v2`

| Tool | API Endpoint | What it returns |
|------|-------------|-----------------|
| `get_recovery` | `GET /recovery` | Recovery score, HRV, resting HR, SpO2, skin temp |
| `get_sleep` | `GET /activity/sleep` | Sleep stages, duration, efficiency, respiratory rate |
| `get_workouts` | `GET /activity/workout` | Workout strain, HR zones, distance, calories |
| `get_cycles` | `GET /cycle` | Daily strain scores and cycle info |
| `get_profile` | `GET /user/profile/basic` | Name, email, user ID |
| `get_body_measurement` | `GET /user/measurement/body` | Height, weight, max HR |

**Date format requirement:** All date query params MUST be full ISO 8601 format.
- Correct: `2026-03-28T00:00:00.000Z`
- Wrong: `2026-03-28` (returns 404, not 400!)

The server auto-converts `YYYY-MM-DD` to ISO 8601 internally.

---

## Claude Desktop Configuration

**Config file:** `C:\Users\Pkenn\AppData\Roaming\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "whoop": {
      "command": "node",
      "args": ["C:\\Users\\Pkenn\\whoop-mcp-server-claude\\dist\\index.js"],
      "env": {
        "WHOOP_CLIENT_ID": "<your-client-id>",
        "WHOOP_CLIENT_SECRET": "<your-client-secret>",
        "WHOOP_REDIRECT_URI": "http://localhost:3001/oauth/callback",
        "MCP_SERVER_PORT": "3001"
      }
    }
  }
}
```

---

## Setup From Scratch (Step by Step)

### 1. Get WHOOP Developer Credentials

1. Go to https://developer.whoop.com
2. Create a developer account
3. Create a new application
4. Set redirect URI to `http://localhost:3001/oauth/callback`
5. Request scopes: `read:recovery read:cycles read:workout read:sleep read:profile read:body_measurement offline`
6. Copy your Client ID and Client Secret

### 2. Clone and Install

```bash
git clone https://github.com/peterankennedy-oss/whoop-mcp-server-claude.git
cd whoop-mcp-server-claude
npm install
```

### 3. Create .env File

```bash
cp env.example .env
```

Edit `.env` with your credentials:
```
WHOOP_CLIENT_ID=your-client-id-here
WHOOP_CLIENT_SECRET=your-client-secret-here
WHOOP_REDIRECT_URI=http://localhost:3001/oauth/callback
MCP_SERVER_PORT=3001
```

### 4. Build

```bash
npm run build
```

This compiles TypeScript from `src/` into `dist/`.

### 5. Configure Claude Desktop

Edit `C:\Users\Pkenn\AppData\Roaming\Claude\claude_desktop_config.json` (create it if it doesn't exist) and add the whoop server config shown above.

### 6. Restart Claude Desktop

Close and reopen Claude Desktop. The WHOOP MCP server will appear in your tools.

### 7. First Authorization

Ask Claude: "Connect to my WHOOP" or "Authorize WHOOP"

Claude will give you an OAuth link. Open it in your browser, log in to WHOOP, and authorize. After the redirect, you're set. Tokens are saved automatically.

---

## Troubleshooting

### "Not authorized yet"
- Tokens haven't been saved yet or expired without a refresh token
- Run `authorize_whoop` again and complete the OAuth flow in your browser

### 404 errors on data endpoints
- **Most likely cause:** Date format. The WHOOP API requires full ISO 8601 dates (`2026-03-28T00:00:00.000Z`), not short dates (`2026-03-28`). The server handles this conversion automatically after our fix.
- **Second cause:** Wrong API version. Must be `/developer/v2`. The v1 API was removed October 2025.

### "Server does not support tools" error
- The MCP SDK version requires `capabilities: { tools: {} }` in the Server constructor
- This was fixed in the codebase - make sure you have the latest `dist/` built

### Server disconnects immediately
- Check `npm run build` succeeds without errors
- Check Node.js version (v18+ required)
- Check the `.env` file exists and has all required vars

### Token refresh fails
- The refresh token may have been revoked
- Re-authorize: ask Claude to run `authorize_whoop`

### Port 3001 already in use
- Another process is using the OAuth callback port
- Kill it: `npx kill-port 3001`
- Or change `MCP_SERVER_PORT` in `.env` and Claude Desktop config

---

## Lessons Learned (Debugging History)

### Lesson 1: WHOOP v1 API is dead
The WHOOP v1 API (`/developer/v1/`) was fully removed after October 1, 2025. All REST endpoints must use `/developer/v2/`. The "v2 migration" documentation mostly discusses webhook changes, which is misleading - the REST paths changed too.

### Lesson 2: WHOOP returns 404 for bad dates (not 400)
This was the hardest bug to find. Passing `start=2026-03-28` instead of `start=2026-03-28T00:00:00.000Z` returns HTTP 404, not 400 Bad Request. This made it look like the endpoint URL was wrong when the real issue was date formatting.

### Lesson 3: MCP servers persist in memory during a session
When you rebuild the `dist/` files, the currently running MCP server process still has the old code in memory. You must restart Claude Desktop (or start a new Claude Code conversation) to pick up changes.

### Lesson 4: Async token refresh race condition
The original code called `refreshToken()` in the constructor with `.then()` but never awaited it. API calls could fire before the refresh completed, causing "Not authorized" errors even though tokens existed. Fix: store the refresh Promise and await it before any API call.

### Lesson 5: MCP SDK capabilities must be declared
The `@modelcontextprotocol/sdk` Server constructor needs `capabilities: { tools: {} }` to enable tool registration. Without it, `setRequestHandler(ListToolsRequestSchema, ...)` throws "Server does not support tools."

### Lesson 6: OAuth callback timing
The OAuth callback server starts when `authorize_whoop` is called and listens for the browser redirect. If the MCP server restarts before you complete auth in the browser, the callback server is gone and auth fails silently. Complete the browser auth promptly after getting the URL.

---

## Security Notes

### What's protected
- `.env` and `whoop-tokens.json` are in `.gitignore` - never committed
- No secrets in git history (verified)
- OAuth uses state parameter to prevent CSRF

### What to be aware of
- `whoop-tokens.json` contains live tokens that grant read access to your WHOOP data
- The Claude Desktop config file contains your client secret in plaintext
- The `auth-app.js` standalone auth tool displays tokens in the browser (only runs locally)
- All data is read-only (no write scopes) - worst case is someone reads your fitness data

### If you suspect token compromise
1. Go to https://developer.whoop.com and revoke your app's access
2. Delete `whoop-tokens.json`
3. Regenerate your client secret
4. Update `.env` and Claude Desktop config with new secret
5. Re-authorize

---

## Quick Reference

| Task | Command |
|------|---------|
| Build after code changes | `npm run build` |
| Check if server works | Ask Claude: "get my WHOOP profile" |
| Re-authorize | Ask Claude: "authorize WHOOP" |
| Check saved tokens | `cat whoop-tokens.json` |
| Test API directly | `curl -H "Authorization: Bearer TOKEN" https://api.prod.whoop.com/developer/v2/user/profile/basic` |

---

*Last updated: April 4, 2026*
*PR with all fixes: https://github.com/nissand/whoop-mcp-server-claude/pull/8*
