import fs from 'fs';
import os from 'os';
import http from 'http';
import { join } from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

// Kill any existing process on the server port (prevents EADDRINUSE)
async function killPortProcess(port) {
    // Step 1: Find and kill processes on the port
    try {
        if (process.platform === 'win32') {
            const result = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
            const lines = result.trim().split('\n');
            const pids = new Set();
            for (const line of lines) {
                const parts = line.trim().split(/\s+/);
                const pid = parts[parts.length - 1];
                if (pid && pid !== '0' && pid !== String(process.pid)) pids.add(pid);
            }
            for (const pid of pids) {
                try {
                    execSync(`taskkill /PID ${pid} /F`, { stdio: 'pipe' });
                    console.log(`[INFO] Killed existing process on port ${port} (PID: ${pid})`);
                } catch (e) { /* Process may have already exited */ }
            }
        } else {
            const result = execSync(`lsof -ti:${port}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
            const pids = result.trim().split('\n').filter(p => p);
            for (const pid of pids) {
                try {
                    execSync(`kill -9 ${pid}`, { stdio: 'pipe' });
                    console.log(`[INFO] Killed existing process on port ${port} (PID: ${pid})`);
                } catch (e) { /* Process may have already exited */ }
            }
        }
    } catch (e) {
        // No process found on port - this is fine
    }

    // Step 2: Wait until port is actually free (max 5 seconds)
    const maxWait = 5000;
    const checkInterval = 200;
    const start = Date.now();
    while (Date.now() - start < maxWait) {
        const isFree = await new Promise(resolve => {
            const testServer = http.createServer();
            testServer.once('error', () => resolve(false));
            testServer.once('listening', () => {
                testServer.close(() => resolve(true));
            });
            testServer.listen(port, '0.0.0.0');
        });
        if (isFree) {
            console.log(`[INFO] Port ${port} is free`);
            return;
        }
        await new Promise(r => setTimeout(r, checkInterval));
    }
    console.warn(`[WARN] Port ${port} may still be in use after ${maxWait}ms wait`);
}

// Get local IP address for mobile access
// Prefers real network IPs (192.168.x.x, 10.x.x.x) over virtual adapters (172.x.x.x from WSL/Docker)
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    const candidates = [];

    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            // Skip internal and non-IPv4 addresses
            if (iface.family === 'IPv4' && !iface.internal) {
                candidates.push({
                    address: iface.address,
                    name: name,
                    // Prioritize common home/office network ranges
                    priority: iface.address.startsWith('192.168.') ? 1 :
                        iface.address.startsWith('10.') ? 2 :
                            iface.address.startsWith('172.') ? 3 : 4
                });
            }
        }
    }

    // Sort by priority and return the best one
    candidates.sort((a, b) => a.priority - b.priority);
    return candidates.length > 0 ? candidates[0].address : 'localhost';
}

// Helper: HTTP GET JSON
function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getcursorStoragePath() {
    if (process.platform === 'win32' && process.env.APPDATA) {
        return join(process.env.APPDATA, 'Cursor', 'User', 'globalStorage', 'storage.json');
    }

    if (process.platform === 'darwin' && process.env.HOME) {
        return join(process.env.HOME, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'storage.json');
    }

    if (process.env.XDG_CONFIG_HOME) {
        return join(process.env.XDG_CONFIG_HOME, 'Cursor', 'User', 'globalStorage', 'storage.json');
    }

    if (process.env.HOME) {
        return join(process.env.HOME, '.config', 'Cursor', 'User', 'globalStorage', 'storage.json');
    }

    return null;
}

function findRecentcursorWorkspace() {
    const storagePath = getcursorStoragePath();
    if (!storagePath || !fs.existsSync(storagePath)) {
        return null;
    }

    try {
        const raw = fs.readFileSync(storagePath, 'utf8').replace(/^\uFEFF/, '');
        const storage = JSON.parse(raw);
        const folderUris = [
            storage?.windowsState?.lastActiveWindow?.folder,
            ...(storage?.backupWorkspaces?.folders || []).map(folder => folder?.folderUri)
        ].filter(Boolean);

        for (const folderUri of folderUris) {
            try {
                const workspacePath = String(folderUri).startsWith('file:')
                    ? fileURLToPath(folderUri)
                    : String(folderUri);
                if (workspacePath && fs.existsSync(workspacePath)) {
                    return workspacePath;
                }
            } catch (error) {
                console.warn(`Ignoring invalid Cursor workspace URI: ${folderUri}`);
            }
        }
    } catch (error) {
        console.warn(`Failed to read cursor storage: ${error.message}`);
    }

    return null;
}

function getTargetWorkspace() {
    return findRecentcursorWorkspace() || process.cwd();
}

function findCommandOnPath(command) {
    const locator = process.platform === 'win32' ? 'where' : 'which';

    try {
        const output = execSync(`${locator} ${command}`, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
        return output.split(/\r?\n/).find(Boolean) || null;
    } catch (error) {
        return null;
    }
}

function findcursorExecutable() {
    if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
        const defaultPath = join(process.env.LOCALAPPDATA, 'Programs', 'Cursor', 'Cursor.exe');
        if (fs.existsSync(defaultPath)) {
            return defaultPath;
        }
    }

    return findCommandOnPath(process.platform === 'win32' ? 'Cursor.exe' : 'Cursor')
        || (process.platform === 'win32' ? findCommandOnPath('Cursor') : null);
}

function findcursorCliCommand() {
    if (process.platform === 'win32') {
        return findCommandOnPath('cursor.cmd')
            || findCommandOnPath('cursor')
            || findCommandOnPath('Cursor');
    }

    return findCommandOnPath('cursor')
        || findCommandOnPath('Cursor');
}

export {
    killPortProcess,
    getLocalIP,
    getJson,
    sleep,
    getcursorStoragePath,
    findRecentcursorWorkspace,
    getTargetWorkspace,
    findCommandOnPath,
    findcursorExecutable,
    findcursorCliCommand
};

