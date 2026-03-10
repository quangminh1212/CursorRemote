# Cursor Remote

Browser-based remote control and live mirror for an active Cursor session.

## What it does

- Mirrors the current Cursor chat in a browser
- Sends prompts to Cursor remotely
- Switches mode and model
- Reads chat history and tabs
- Uploads files into the active chat
- Exposes health/debug endpoints
- Supports phone access over local network

## How it works

Cursor Remote attaches to Cursor through the Chrome DevTools Protocol (CDP), reads live UI state, and serves a browser dashboard over HTTP/HTTPS with WebSocket-based sync.

## Tech stack

- Node.js
- Express
- WebSocket (`ws`)
- CDP automation
- Plain frontend assets in `public/`

## Project structure

```text
.
├─ server.js
├─ run.bat
├─ smoke-test.js
├─ package.json
├─ public/
├─ src/server/
├─ certs/
├─ uploads/
└─ output/
```

## Quick start

### Prerequisites

- Node.js 16+
- Cursor installed locally
- Windows is the main target environment

### Install

```bash
npm install
```

### Run

```bash
npm start
```

Or use the Windows launcher:

```bat
run.bat
```

### Dev mode

```bash
npm run dev
```

## Scripts

- `npm start` — start server
- `npm run dev` — dev server with nodemon
- `npm run smoke` — smoke test
- `npm run tauri:dev` — run Tauri dev build
- `npm run tauri:build` — build Tauri app

## Runtime notes

- Cursor is the source of truth
- CDP connection is required for full remote control
- `/health` can report `http`, `connected`, or `ready`
- `uploads/`, `certs/`, and log files are runtime artifacts

## API surface

Main routes include:

- `GET /health`
- `GET /snapshot`
- `GET /app-state`
- `POST /send`
- `POST /upload`
- `POST /set-mode`
- `POST /set-model`
- `GET /chat-history`

## Security

- Localhost can bypass auth for convenience
- Remote access uses password-based auth cookie flow
- WebSocket connections are authenticated

## Status

Project is under active iteration and focused on making remote Cursor control more stable on real Windows setups.
