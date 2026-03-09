@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Cursor Remote Launcher
chcp 65001 >nul 2>&1

cd /d "%~dp0"

set "RUN_LOG=%CD%\run-launch.log"
set "CAN_PAUSE=1"
for /f "usebackq delims=" %%r in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "[Console]::IsInputRedirected" 2^>nul`) do (
    if /i "%%r"=="True" set "CAN_PAUSE=0"
)
call :log "========================================"
call :log "Launcher started in %CD%"

set "MODE=auto"
set "SERVER_MODE=stable"
set "OPEN_BROWSER=1"
set "VERIFY_STARTUP=1"
set "REQUESTED_PORT="
set "CR_VISIBLE_CURSOR=1"

:parse_args
if "%~1"=="" goto args_done
if /i "%~1"=="--server-only" set "MODE=server"
if /i "%~1"=="-s" set "MODE=server"
if /i "%~1"=="--desktop" set "MODE=desktop"
if /i "%~1"=="--dev" set "SERVER_MODE=dev"
if /i "%~1"=="--no-open" set "OPEN_BROWSER=0"
if /i "%~1"=="--no-verify" set "VERIFY_STARTUP=0"
if /i "%~1"=="--port" (
    shift
    call set "REQUESTED_PORT=%%~1"
    if defined REQUESTED_PORT (
        call :validate_port_number "!REQUESTED_PORT!"
        if "!PORT_VALID!"=="0" (
            echo       [WARN] Ignoring invalid --port value: !REQUESTED_PORT!
            call :log "Invalid --port value ignored: !REQUESTED_PORT!"
            set "REQUESTED_PORT="
        )
    ) else (
        echo       [WARN] --port was provided without a value. Ignoring.
        call :log "--port missing value"
    )
)
shift
goto parse_args

:args_done
echo ============================================
echo  Cursor Remote Launcher
echo ============================================
echo.

echo [1/7] Checking runtime tools...
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo         Download from: https://nodejs.org/
    call :log "Node.js not found"
    call :pause_if_interactive
    exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] npm is not installed or not in PATH.
    call :log "npm not found"
    call :pause_if_interactive
    exit /b 1
)

where curl >nul 2>nul
if errorlevel 1 (
    echo [ERROR] curl is required for Cursor CDP detection on Windows.
    call :log "curl not found"
    call :pause_if_interactive
    exit /b 1
)

for /f "tokens=*" %%v in ('node --version') do echo       Node.js %%v detected.
for /f "tokens=*" %%v in ('npm --version') do echo       npm %%v detected.
echo.

echo [2/7] Checking dependencies...
if not exist "node_modules" (
    echo       Installing npm dependencies...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        call :log "npm install failed"
        call :pause_if_interactive
        exit /b 1
    )
    echo       Dependencies installed.
) else (
    echo       npm dependencies OK.
)
echo.

echo [3/7] Checking environment...
if exist ".env" (
    echo       .env configuration OK.
    call :log ".env found"
) else (
    echo       [INFO] .env not found. Using built-in defaults from server.js.
    echo              Default PORT=3000 and APP_PASSWORD=Cursor unless overridden.
    call :log ".env missing; using server defaults"
)

set "BROWSER_PROTOCOL=http"
if exist "certs\server.key" if exist "certs\server.cert" set "BROWSER_PROTOCOL=https"
echo.

echo [4/7] Detecting target Cursor workspace...
set "LAST_REPO="
set "TARGET_REPO=%CD%"
set "CURSOR_STORAGE_JSON=%APPDATA%\Cursor\User\globalStorage\storage.json"

if exist "!CURSOR_STORAGE_JSON!" (
    for /f "usebackq delims=" %%i in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$storage = $env:APPDATA + '\Cursor\User\globalStorage\storage.json'; try { $json = Get-Content -Raw -LiteralPath $storage | ConvertFrom-Json; $uri = $json.windowsState.lastActiveWindow.folder; if (-not $uri -and $json.backupWorkspaces.folders -and $json.backupWorkspaces.folders.Count -gt 0) { $uri = $json.backupWorkspaces.folders[0].folderUri }; if ($uri) { $path = [System.Uri]::new($uri).LocalPath; if ($path -match '^/[A-Za-z]:') { $path = $path.Substring(1) }; $path = $path -replace '/', '\'; $path } } catch { }"`) do (
        set "LAST_REPO=%%i"
    )
)

if defined LAST_REPO (
    if exist "!LAST_REPO!" (
        set "TARGET_REPO=!LAST_REPO!"
        echo       Last active Cursor workspace: !TARGET_REPO!
    ) else (
        echo       [WARN] Last workspace from Cursor storage was not found: !LAST_REPO!
        echo       [INFO] Falling back to current folder: !TARGET_REPO!
    )
) else (
    echo       [INFO] No recent Cursor workspace found. Using current folder: !TARGET_REPO!
)
call :log "Target workspace: !TARGET_REPO!"
call :resolve_cursor_exe
echo.

echo [5/7] Checking Cursor CDP connection...
echo       Cursor auto-launch mode: visible window
set "CDP_FOUND=0"
set "CURSOR_CDP_PORT="
for %%p in (9000 9001 9002 9003) do (
    if !CDP_FOUND!==0 (
        curl -s -o nul -w "%%{http_code}" http://127.0.0.1:%%p/json/list >nul 2>nul
        if !errorlevel!==0 (
            set "IS_CURSOR=0"
            for /f "usebackq delims=" %%v in (`curl -s http://127.0.0.1:%%p/json/version 2^>nul ^| findstr /i "Cursor"`) do (
                set "IS_CURSOR=1"
            )
            if !IS_CURSOR!==1 (
                curl -s http://127.0.0.1:%%p/json/list 2>nul | findstr /i "webSocketDebuggerUrl" >nul 2>nul
                if !errorlevel!==0 (
                    echo       CDP found on port %%p ^(verified: Cursor^)
                    set "CDP_FOUND=1"
                    set "CURSOR_CDP_PORT=%%p"
                    call :log "Found Cursor CDP on port %%p"
                )
            ) else (
                echo       [INFO] Port %%p has CDP but not Cursor ^(skipping^)
            )
        )
    )
)

if !CDP_FOUND!==0 (
    echo       [WARN] Cursor CDP not found on ports 9000-9003.
    echo       [INFO] Attempting to launch Cursor with remote debugging...
    if "!CURSOR_EXE!"=="" (
        echo       [WARN] Cursor.exe not found. The server will still start and keep retrying CDP.
        call :log "Cursor.exe not found"
    ) else (
        set "CDP_PORT=9000"
        for %%q in (9000 9001 9002 9003) do (
            if !CDP_FOUND!==0 (
                curl -s -o nul http://127.0.0.1:%%q/json/version >nul 2>nul
                if !errorlevel! neq 0 (
                    set "CDP_PORT=%%q"
                    set "CDP_FOUND=99"
                )
            )
        )
        set "CDP_FOUND=0"

        set "ARGV_DIR=%APPDATA%\Cursor"
        set "ARGV_FILE=!ARGV_DIR!\argv.json"
        if not exist "!ARGV_DIR!" mkdir "!ARGV_DIR!" >nul 2>nul
        > "!ARGV_FILE!" echo {"remote-debugging-port": !CDP_PORT!}
        echo       Injected remote-debugging-port=!CDP_PORT! into argv.json
        call :log "Updated Cursor argv.json with remote-debugging-port=!CDP_PORT!"

        taskkill /f /im Cursor.exe >nul 2>&1
        timeout /t 2 /nobreak >nul

        echo       Launching Cursor visibly on workspace: !TARGET_REPO!
        start "" "!CURSOR_EXE!" "!TARGET_REPO!" --remote-debugging-port=!CDP_PORT!
        ping -n 4 127.0.0.1 >nul

        tasklist /FI "IMAGENAME eq Cursor.exe" /NH 2>nul | findstr /i "Cursor.exe" >nul 2>nul
        if !errorlevel! neq 0 (
            echo       [INFO] CLI flag not accepted, retrying visibly with argv.json only...
            start "" "!CURSOR_EXE!" "!TARGET_REPO!"
        )

        echo       Waiting for Cursor CDP to become ready...
        set "CDP_READY=0"
        for /l %%i in (1,1,20) do (
            if !CDP_READY!==0 (
                timeout /t 2 /nobreak >nul
                curl -s http://127.0.0.1:!CDP_PORT!/json/version 2>nul | findstr /i "Cursor" >nul 2>nul
                if !errorlevel!==0 (
                    echo       CDP ready on port !CDP_PORT! ^(verified: Cursor^)
                    set "CDP_READY=1"
                    set "CURSOR_CDP_PORT=!CDP_PORT!"
                    call :log "Cursor CDP became ready on port !CDP_PORT!"
                )
            )
        )

        if !CDP_READY!==0 (
            echo       [WARN] Cursor launched but CDP is still not confirmed after 40 seconds.
            echo              The server startup check will verify again.
            call :log "Cursor CDP not confirmed after launch wait"
        )
    )
) else (
    echo       Cursor CDP is already available.
)
call :ensure_cursor_visible
echo.

set "CR_SKIP_AUTO_LAUNCH=1"

echo [6/7] Preparing runtime...
call :stop_workspace_servers

set "PREFERRED_PORT=%REQUESTED_PORT%"
if not defined PREFERRED_PORT set "PREFERRED_PORT=3000"
call :select_run_port !PREFERRED_PORT!
if not defined RUN_PORT (
    echo [ERROR] Could not find a free port for Cursor Remote.
    call :log "No free application port found"
    call :pause_if_interactive
    exit /b 1
)

set "PORT=!RUN_PORT!"
if /i "!BROWSER_PROTOCOL!"=="https" (
    set "BROWSER_URL=https://127.0.0.1:!PORT!"
) else (
    set "BROWSER_URL=http://127.0.0.1:!PORT!"
)
call :log "Selected port !PORT! with protocol !BROWSER_PROTOCOL!"

set "TAURI_READY=0"
for %%f in (
    "tauri.conf.json"
    "tauri.conf.json5"
    "Tauri.toml"
    "src-tauri\tauri.conf.json"
    "src-tauri\tauri.conf.json5"
    "src-tauri\Tauri.toml"
) do (
    if exist %%~f set "TAURI_READY=1"
)
if "!TAURI_READY!"=="1" if not exist "tauri-server.mjs" set "TAURI_READY=0"

if /i "!MODE!"=="auto" (
    if "!TAURI_READY!"=="1" (
        set "MODE=desktop"
    ) else (
        set "MODE=server"
    )
)
echo       Launch mode: !MODE!
echo       App URL: !BROWSER_URL!
echo.

echo [7/7] Launching project...
if /i "!MODE!"=="desktop" goto :desktop_mode
goto :server_mode

:desktop_mode
if "!TAURI_READY!"=="0" (
    echo [WARN] Desktop webview is not available in this repo.
    echo        Falling back to browser mode.
    call :log "Tauri assets missing; falling back to browser mode"
    goto :server_mode
)

echo ============================================
echo  Mode:       DESKTOP
echo  Port:       !PORT!
echo  Workspace:  !TARGET_REPO!
echo ============================================
echo.
call :log "Launching Tauri desktop mode"
npx tauri dev
set "TAURI_EXIT=%errorlevel%"
if not "!TAURI_EXIT!"=="0" (
    echo [ERROR] Tauri dev failed with exit code !TAURI_EXIT!.
    call :log "Tauri dev failed with exit code !TAURI_EXIT!"
    call :pause_if_interactive
)
exit /b !TAURI_EXIT!

:server_mode
if /i "!SERVER_MODE!"=="dev" (
    set "SERVER_COMMAND=npx nodemon --watch server.js --watch public --watch generate_ssl.js --ext js,html,css,json --ignore log.txt --ignore log.old.txt --ignore debug.log --ignore node_modules --signal SIGTERM --delay 2 server.js"
) else (
    set "SERVER_COMMAND=node server.js"
)

echo ============================================
echo  Mode:       BROWSER
echo  Server:     !BROWSER_URL!
echo  Runtime:    !SERVER_MODE!
echo  Open UI:    !OPEN_BROWSER!
echo  Verify:     !VERIFY_STARTUP!
echo  Console:    current window
echo  Logs:       cursor-remote.log, run-launch.log
echo ============================================
echo.

call :log "Starting browser mode with command: !SERVER_COMMAND!"
echo       Starting server in the current console window...
start /b "" cmd /c "cd /d ""%CD%"" && set PORT=!PORT! && set CR_SKIP_AUTO_LAUNCH=1 && !SERVER_COMMAND!"

if "!VERIFY_STARTUP!"=="1" (
    call :verify_server_startup
    if errorlevel 1 (
        echo [ERROR] Startup verification failed. Check cursor-remote.log and run-launch.log.
        call :log "Startup verification failed"
        call :pause_if_interactive
        exit /b 1
    )
) else (
    echo       Startup verification skipped by flag.
    call :log "Startup verification skipped"
)

if "!OPEN_BROWSER!"=="1" (
    start "" "!BROWSER_URL!"
    call :log "Opened browser at !BROWSER_URL!"
)

echo [OK] Cursor Remote is running.
echo      Local URL: !BROWSER_URL!
if defined MOBILE_URL echo      Mobile URL: !MOBILE_URL!
echo      Server is attached to this console window.
echo.
exit /b 0

:verify_server_startup
set "STARTUP_READY=0"
set "VERIFY_STATE="
set "APP_MODE="
set "APP_MODEL="
set "HAS_CHAT="
set "MOBILE_URL="

echo       Waiting for the server to report ready state...
for /l %%i in (1,1,45) do (
    set "VERIFY_RESULT="
    for /f "usebackq delims=" %%r in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference = 'SilentlyContinue'; [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }; try { $base = '!BROWSER_URL!'; $health = Invoke-RestMethod -Uri ($base + '/health') -TimeoutSec 2; $state = Invoke-RestMethod -Uri ($base + '/app-state') -TimeoutSec 2; $snapshotOk = $false; try { $snapshot = Invoke-RestMethod -Uri ($base + '/snapshot') -TimeoutSec 2; $snapshotOk = [bool]$snapshot.html } catch { $snapshotOk = $false }; if ($health.status -eq 'ok' -and $health.cdpConnected -and $snapshotOk -and $state.editorFound) { Write-Output ('ready|' + $state.mode + '|' + $state.model + '|' + $state.hasChat) } elseif ($health.status -eq 'ok' -and $health.cdpConnected) { Write-Output ('connected|' + $state.mode + '|' + $state.model + '|' + $state.hasChat) } elseif ($health.status -eq 'ok') { Write-Output 'http' } } catch { }"`) do (
        set "VERIFY_RESULT=%%r"
    )

    if defined VERIFY_RESULT (
        for /f "tokens=1-4 delims=|" %%a in ("!VERIFY_RESULT!") do (
            set "VERIFY_STATE=%%a"
            set "APP_MODE=%%b"
            set "APP_MODEL=%%c"
            set "HAS_CHAT=%%d"
        )

        if /i "!VERIFY_STATE!"=="ready" (
            set "STARTUP_READY=1"
            goto verify_ready
        )
    )

    >nul timeout /t 2 /nobreak
)

if /i "!VERIFY_STATE!"=="connected" (
    echo       [WARN] HTTP server is up and Cursor CDP is connected,
    echo              but the live chat snapshot or editor is not ready yet.
    echo              Open Cursor chat, wait a few seconds, then refresh the web UI.
    call :log "Verification ended in connected-only state"
    exit /b 0
)

echo       [ERROR] Timed out waiting for !BROWSER_URL! to become ready.
call :log "Timed out waiting for startup readiness"
exit /b 1

:verify_ready
for /f "usebackq delims=" %%u in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference = 'SilentlyContinue'; [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }; try { $r = Invoke-RestMethod -Uri '!BROWSER_URL!/qr-info' -TimeoutSec 2; if ($r.connectUrl) { $r.connectUrl } } catch { }"`) do (
    set "MOBILE_URL=%%u"
)

echo       Server is ready. Cursor chat control is available.
if defined APP_MODE echo       Cursor mode: !APP_MODE!
if defined APP_MODEL echo       Cursor model: !APP_MODEL!
if defined HAS_CHAT echo       Active chat open: !HAS_CHAT!
call :log "Server ready with mode=!APP_MODE! model=!APP_MODEL! hasChat=!HAS_CHAT!"
exit /b 0

:select_run_port
set "RUN_PORT="
call :is_port_free %~1
if "!PORT_FREE!"=="1" (
    set "RUN_PORT=%~1"
    exit /b 0
)

echo       [WARN] Port %~1 is busy. Scanning fallback ports...
for %%p in (3000 3001 3002 3003 3004 3005) do (
    call :is_port_free %%p
    if "!PORT_FREE!"=="1" (
        set "RUN_PORT=%%p"
        echo       Using fallback port %%p.
        exit /b 0
    )
)
exit /b 1

:is_port_free
set "PORT_FREE=0"
2>nul netstat -ano | findstr /R /C:":%~1 .*LISTENING" >nul
if errorlevel 1 set "PORT_FREE=1"
exit /b 0

:validate_port_number
set "PORT_VALID=0"
set "PORT_NUMBER=%~1"
if not defined PORT_NUMBER exit /b 0
echo(!PORT_NUMBER!| findstr /R "^[0-9][0-9]*$" >nul || exit /b 0
set /a PORT_NUMBER+=0 2>nul
if errorlevel 1 exit /b 0
if !PORT_NUMBER! GEQ 1 if !PORT_NUMBER! LEQ 65535 set "PORT_VALID=1"
exit /b 0

:stop_workspace_servers
echo       Stopping existing Cursor Remote server processes for this workspace...
set "FOUND_WORKSPACE_PROCESS=0"
for /f "usebackq delims=" %%p in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$workspace = [regex]::Escape((Get-Location).Path); Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -match $workspace -and ($_.CommandLine -match 'server\.js' -or $_.CommandLine -match 'nodemon') } | Select-Object -ExpandProperty ProcessId -Unique"`) do (
    if not "%%p"=="" (
        set "FOUND_WORKSPACE_PROCESS=1"
        echo         - PID %%p
        taskkill /PID %%p /T /F >nul 2>&1
        call :log "Stopped workspace server PID %%p"
    )
)
if "!FOUND_WORKSPACE_PROCESS!"=="0" echo         No existing workspace server process found.
exit /b 0

:resolve_cursor_exe
set "CURSOR_EXE="
if exist "%LOCALAPPDATA%\Programs\Cursor\Cursor.exe" set "CURSOR_EXE=%LOCALAPPDATA%\Programs\Cursor\Cursor.exe"
exit /b 0

:ensure_cursor_visible
set "CURSOR_WINDOW_ACTION="
if "!CURSOR_EXE!"=="" (
    echo       [WARN] Cursor.exe not found locally, cannot force visible window.
    call :log "Cursor window action: missing-exe"
    exit /b 0
)

for /f "usebackq delims=" %%r in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; $cursorExe = $env:CURSOR_EXE; $workspace = $env:TARGET_REPO; $shell = New-Object -ComObject WScript.Shell; if ($shell.AppActivate('Cursor')) { Start-Sleep -Milliseconds 300; Write-Output 'focused'; exit 0 }; $proc = Start-Process -FilePath $cursorExe -ArgumentList @($workspace) -PassThru; Start-Sleep -Seconds 3; if ($shell.AppActivate($proc.Id)) { Write-Output 'launched'; exit 0 }; if ($shell.AppActivate('Cursor')) { Write-Output 'launched'; exit 0 }; Write-Output 'started'"`) do (
    set "CURSOR_WINDOW_ACTION=%%r"
)

if /i "!CURSOR_WINDOW_ACTION!"=="focused" (
    echo       Cursor window is visible and focused.
    call :log "Cursor window action: focused"
    exit /b 0
)
if /i "!CURSOR_WINDOW_ACTION!"=="launched" (
    echo       Cursor was launched visibly for workspace: !TARGET_REPO!
    call :log "Cursor window action: launched"
    exit /b 0
)
if /i "!CURSOR_WINDOW_ACTION!"=="started" (
    echo       Cursor launch requested. Window should appear shortly.
    call :log "Cursor window action: started"
    exit /b 0
)

echo       [WARN] Could not confirm Cursor window state, but launch/focus was requested.
call :log "Cursor window action: unknown"
exit /b 0

:log
>> "%RUN_LOG%" echo [%date% %time%] %~1
exit /b 0

:pause_if_interactive
if "!CAN_PAUSE!"=="1" pause
exit /b 0
