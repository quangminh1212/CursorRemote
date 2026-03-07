# Cursor Remote

Web-based remote interface for monitoring and controlling Cursor IDE sessions from any device.

## Features

- 🔄 **Real-time mirroring** - Live snapshots of Cursor chat interface
- 📱 **Mobile-friendly** - Premium dark theme UI optimized for phones
- 💬 **Remote control** - Send messages, stop generations, change modes/models
- 📎 **File upload** - Attach files directly from your phone
- 📋 **Chat history** - Browse and switch between conversations
- 🔒 **Secure** - SSL/HTTPS support with password authentication
- 🌐 **Global access** - ngrok tunneling for remote connections
- 🖥️ **Desktop app** - Optional Tauri window for desktop webview

## Quick Start

### Option 1: Run script (recommended)
```bash
run.bat                    # Full mode (Tauri window + server)
run.bat --server-only      # Server only (browser access)
```

### Option 2: Manual
```bash
npm install
node server.js
```

### Prerequisites
1. **Cursor IDE** must be running with CDP enabled:
   ```
   cursor . --remote-debugging-port=9000
   ```
2. **Node.js** >= 16.0.0

## Configuration

Copy `.env.example` to `.env` and customize:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `APP_PASSWORD` | `Cursor` | Remote access password |
| `SESSION_SECRET` | auto | Cookie signing secret |

## Architecture

```
Phone/Browser  <-->  Node.js Server  <-->  Cursor IDE (CDP)
     |                    |
   WebSocket          Chrome DevTools
   (real-time)         Protocol
```

## License

GPL-3.0-only
