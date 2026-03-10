import fs from 'fs';
import os from 'os';
import { join, dirname } from 'path';
import { execSync, spawn } from 'child_process';
import { findcursorExecutable, findcursorCliCommand, getcursorStoragePath, getTargetWorkspace, sleep } from './system-utils.js';
import { discoverCDP } from './cdp-connection.js';

// Module-level state for launch deduplication
let cursorLaunchPromise = null;

export function iscursorRunning() {
    try {
        if (process.platform === 'win32') {
            const output = execSync('tasklist /FI "IMAGENAME eq Cursor.exe"', {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            });
            return output.toLowerCase().includes('cursor.exe');
        }

        execSync('pgrep -f cursor', { stdio: 'ignore' });
        return true;
    } catch (error) {
        return false;
    }
}

export function killcursorProcesses() {
    try {
        if (process.platform === 'win32') {
            const ancestors = new Set();
            let cur = process.pid;
            while (cur && cur !== 0) {
                ancestors.add(cur);
                try {
                    const out = execSync(`wmic process where "ProcessId=${cur}" get ParentProcessId /value`, { stdio: ['pipe', 'pipe', 'ignore'], encoding: 'utf8' });
                    const m = out.match(/ParentProcessId=(\d+)/);
                    const parent = m ? parseInt(m[1], 10) : 0;
                    if (!parent || parent === cur) break;
                    cur = parent;
                } catch { break; }
            }
            const ancestorList = [...ancestors].join(',');
            execSync(
                `powershell -NoProfile -NonInteractive -WindowStyle Hidden -Command "Get-Process -Name 'Cursor' -ErrorAction SilentlyContinue | Where-Object { @(${ancestorList}) -notcontains $_.Id } | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }"`,
                { stdio: 'ignore' }
            );
            return;
        }

        execSync('pkill -f cursor', { stdio: 'ignore' });
    } catch (error) {
        // Ignore "not running" failures.
    }
}

async function waitForCDP(timeoutMs = 30000) {
    const start = Date.now();
    while ((Date.now() - start) < timeoutMs) {
        try {
            await discoverCDP();
            return true;
        } catch (error) {
            await sleep(1000);
        }
    }
    return false;
}

// Inject remote-debugging-port into Cursor's argv.json
// Cursor 2.6.13+ reads Electron flags from %APPDATA%\Cursor\argv.json
export function getCursorArgvPath() {
    if (process.platform === 'win32' && process.env.APPDATA) {
        return join(process.env.APPDATA, 'Cursor', 'argv.json');
    }
    if (process.platform === 'darwin' && process.env.HOME) {
        return join(process.env.HOME, 'Library', 'Application Support', 'Cursor', 'argv.json');
    }
    if (process.env.HOME) {
        return join(process.env.HOME, '.config', 'Cursor', 'argv.json');
    }
    return null;
}

export function ensureCursorArgvCDP(port) {
    const argvPath = getCursorArgvPath();
    if (!argvPath) return false;

    try {
        let argv = {};
        if (fs.existsSync(argvPath)) {
            const raw = fs.readFileSync(argvPath, 'utf8')
                .replace(/^\uFEFF/, '')
                .replace(/\/\/.*/g, '');
            try {
                argv = JSON.parse(raw);
            } catch (e) {
                console.warn(`Could not parse existing argv.json, will overwrite: ${e.message}`);
                argv = {};
            }
        }

        if (argv['remote-debugging-port'] === port) {
            return true;
        }

        argv['remote-debugging-port'] = port;

        const dir = dirname(argvPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(argvPath, JSON.stringify(argv, null, 4), 'utf8');
        return true;
    } catch (error) {
        console.error(`Failed to write Cursor argv.json: ${error.message}`);
        return false;
    }
}

export async function launchcursorWithCDP({
    AUTO_LAUNCH = true,
    PRIMARY_CDP_PORT = 9000,
    FORCE_VISIBLE = false
} = {}) {
    if (!AUTO_LAUNCH) {
        return { skipped: true };
    }

    if (cursorLaunchPromise) {
        return cursorLaunchPromise;
    }

    cursorLaunchPromise = (async () => {
        const executable = findcursorExecutable();
        if (!executable) {
            console.warn('Cursor executable not found. Start Cursor manually with CDP enabled.');
            return { attempted: false, reason: 'missing-executable' };
        }

        const cursorCli = findcursorCliCommand();
        const targetWorkspace = getTargetWorkspace();

        // Step 1: Ensure argv.json has remote-debugging-port
        const argvInjected = ensureCursorArgvCDP(PRIMARY_CDP_PORT);
        if (argvInjected) {
            console.log(`Injected remote-debugging-port=${PRIMARY_CDP_PORT} into Cursor argv.json`);
        }

        // Step 2: Kill and restart Cursor so it picks up the new argv.json
        if (iscursorRunning()) {
            console.log(`Cursor is running without CDP. Restarting to enable CDP on port ${PRIMARY_CDP_PORT}...`);
            killcursorProcesses();
            await sleep(2500);
        } else {
            console.log(`Cursor is not running. Launching with CDP on port ${PRIMARY_CDP_PORT}...`);
        }

        console.log(`Opening Cursor on workspace: ${targetWorkspace}`);
        if (FORCE_VISIBLE) {
            console.log('Cursor launch mode: visible window');
        }

        // Step 3: Launch Cursor - use multiple strategies
        let launched = false;
        let ready = false;

        // Strategy A0: Prefer Cursor CLI command (more reliable on recent Windows builds)
        if (cursorCli && !launched) {
            try {
                if (process.platform === 'win32') {
                    const child = spawn('cmd', [
                        '/c',
                        cursorCli,
                        targetWorkspace,
                        `--remote-debugging-port=${PRIMARY_CDP_PORT}`
                    ], {
                        detached: true,
                        stdio: 'ignore',
                        windowsHide: !FORCE_VISIBLE
                    });
                    child.unref();
                } else {
                    const child = spawn(cursorCli, [
                        targetWorkspace,
                        `--remote-debugging-port=${PRIMARY_CDP_PORT}`
                    ], {
                        detached: true,
                        stdio: 'ignore'
                    });
                    child.unref();
                }

                console.log(`Cursor launch command issued via CLI: ${cursorCli}`);
                ready = await waitForCDP(12000);
                if (ready) {
                    launched = true;
                    console.log('Cursor CDP became ready after CLI launch');
                }
            } catch (error) {
                console.warn(`Strategy A0 (cursor CLI launch) failed: ${error.message}`);
            }
        }

        // Strategy A1: Direct spawn with CLI flag
        if (!launched) {
            try {
                const child = spawn(executable, [
                    targetWorkspace,
                    `--remote-debugging-port=${PRIMARY_CDP_PORT}`
                ], {
                    detached: true,
                    stdio: 'ignore',
                    windowsHide: !FORCE_VISIBLE
                });

                const quickExitCode = await Promise.race([
                    new Promise(resolve => child.on('exit', resolve)),
                    new Promise(resolve => setTimeout(() => resolve(null), 3000))
                ]);

                if (quickExitCode === null) {
                    child.unref();
                    launched = true;
                    console.log('Cursor launched with --remote-debugging-port CLI flag');
                } else if (quickExitCode === 9 || quickExitCode === 1) {
                    console.log(`Cursor rejected --remote-debugging-port CLI flag (exit ${quickExitCode}), using argv.json fallback`);
                    ready = await waitForCDP(10000);
                    if (ready) {
                        launched = true;
                        console.log('Cursor exposed CDP after launcher exit; skipping argv.json fallback');
                    }
                } else if (quickExitCode === 0) {
                    console.log('Cursor delegated to existing instance (exit 0)');
                    launched = true;
                }
            } catch (error) {
                console.warn(`Strategy A1 (direct spawn) failed: ${error.message}`);
            }
        }

        // Strategy B: Launch via cmd start
        if (!launched) {
            try {
                const launchTarget = cursorCli || executable;
                const launchArgs = process.platform === 'win32'
                    ? ['/c', 'start', '', launchTarget, targetWorkspace, `--remote-debugging-port=${PRIMARY_CDP_PORT}`]
                    : [targetWorkspace];
                const child = process.platform === 'win32'
                    ? spawn('cmd', launchArgs, {
                        detached: true,
                        stdio: 'ignore',
                        windowsHide: true
                    })
                    : spawn(executable, launchArgs, {
                        detached: true,
                        stdio: 'ignore'
                    });
                child.unref();
                launched = true;
                console.log(`Cursor launched via fallback command (${process.platform === 'win32' ? 'cmd start' : 'direct spawn'})`);
            } catch (error) {
                console.warn(`Strategy B (cmd start) failed: ${error.message}`);
            }
        }

        // Strategy C: Launch via explorer.exe (last resort)
        if (!launched) {
            try {
                const child = spawn('explorer.exe', [executable], {
                    detached: true,
                    stdio: 'ignore'
                });
                child.unref();
                launched = true;
                console.log('Cursor launched via explorer.exe (shell activation)');
            } catch (error) {
                console.error(`All launch strategies failed. Last error: ${error.message}`);
                return { attempted: false, reason: 'spawn-failed', error: error.message };
            }
        }

        if (!ready) {
            ready = await waitForCDP(45000);
        }
        if (ready) {
            console.log(`Cursor CDP is ready on port ${PRIMARY_CDP_PORT}.`);
        } else {
            console.warn('Cursor launched, but CDP is still not available after 45s.');
            console.warn('   Ensure Cursor reads argv.json from: ' + getCursorArgvPath());
            console.warn('   Or start Cursor manually with: --remote-debugging-port=9000');
        }

        return { attempted: true, ready, targetWorkspace };
    })().finally(() => {
        cursorLaunchPromise = null;
    });

    return cursorLaunchPromise;
}
