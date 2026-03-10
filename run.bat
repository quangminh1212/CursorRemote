@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Cursor Remote Launcher
chcp 65001 >nul 2>&1

cd /d "%~dp0"
set "CR_RUNTIME_DIR=%CD%"
set "PS_CMD=powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden"

set "RUN_LOG=%CD%\log.txt"
set "RUN_LOG_OLD=%CD%\log.old.txt"
set "CURSOR_STDOUT_LOG=%CD%\cursor-launch.stdout.log"
set "CURSOR_STDERR_LOG=%CD%\cursor-launch.stderr.log"
call :reset_runtime_logs
set "CAN_PAUSE=1"
set "CAN_CLEAR_SCREEN=1"
for /f "usebackq delims=" %%r in (`!PS_CMD! -Command "[Console]::IsInputRedirected" 2^>nul`) do (
    if /i "%%r"=="True" set "CAN_PAUSE=0"
)
for /f "usebackq delims=" %%r in (`!PS_CMD! -Command "[Console]::IsOutputRedirected" 2^>nul`) do (
    if /i "%%r"=="True" set "CAN_CLEAR_SCREEN=0"
)
call :log "========================================"
call :log "Launcher started in %CD%"

set "MODE=auto"
set "SERVER_MODE=stable"
set "OPEN_BROWSER=1"
set "VERIFY_STARTUP=1"
set "KEEP_HOST_WINDOW=auto"
set "REQUESTED_PORT="
set "CR_VISIBLE_CURSOR=1"
set "CR_TERMINAL_LOG=0"

:parse_args
if "%~1"=="" goto args_done
if /i "%~1"=="--server-only" set "MODE=server"
if /i "%~1"=="-s" set "MODE=server"
if /i "%~1"=="--desktop" set "MODE=desktop"
if /i "%~1"=="--dev" set "SERVER_MODE=dev"
if /i "%~1"=="--hot" set "SERVER_MODE=dev"
if /i "%~1"=="--watch" set "SERVER_MODE=dev"
if /i "%~1"=="--no-open" set "OPEN_BROWSER=0"
if /i "%~1"=="--no-verify" set "VERIFY_STARTUP=0"
if /i "%~1"=="--detach" set "KEEP_HOST_WINDOW=0"
if /i "%~1"=="--hold" set "KEEP_HOST_WINDOW=1"
if /i "%~1"=="--port" (
    set "NEXT_ARG=%~2"
    if defined NEXT_ARG if not "!NEXT_ARG:~0,1!"=="-" (
        set "REQUESTED_PORT=!NEXT_ARG!"
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
    if defined NEXT_ARG if not "!NEXT_ARG:~0,1!"=="-" shift
)
shift
goto parse_args

:args_done
if /i "!KEEP_HOST_WINDOW!"=="auto" (
    if "!CAN_PAUSE!"=="1" (
        set "KEEP_HOST_WINDOW=1"
    ) else (
        set "KEEP_HOST_WINDOW=0"
    )
)
if "!KEEP_HOST_WINDOW!"=="1" (
    set "CONSOLE_MODE=attached"
) else (
    set "CONSOLE_MODE=detached"
)
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

echo       Ensuring local HTTPS certificates...
call :ensure_https_certificates
if errorlevel 1 (
    echo [ERROR] HTTPS is required, but certificates could not be prepared.
    call :log "HTTPS certificate preparation failed"
    call :pause_if_interactive
    exit /b 1
)
set "BROWSER_PROTOCOL=https"
echo.

echo [4/7] Detecting target Cursor workspace...
set "LAST_REPO="
set "TARGET_REPO=%CD%"
set "CURSOR_STORAGE_JSON=%APPDATA%\Cursor\User\globalStorage\storage.json"
call :ensure_json_utf8_no_bom "!CURSOR_STORAGE_JSON!"

if exist "!CURSOR_STORAGE_JSON!" (
    for /f "usebackq delims=" %%i in (`!PS_CMD! -Command "$storage = $env:APPDATA + '\Cursor\User\globalStorage\storage.json'; try { $json = Get-Content -Raw -LiteralPath $storage | ConvertFrom-Json; $uri = $json.windowsState.lastActiveWindow.folder; if (-not $uri -and $json.backupWorkspaces.folders -and $json.backupWorkspaces.folders.Count -gt 0) { $uri = $json.backupWorkspaces.folders[0].folderUri }; if ($uri) { $path = [System.Uri]::new($uri).LocalPath; if ($path -match '^/[A-Za-z]:') { $path = $path.Substring(1) }; $path = $path -replace '/', '\'; $path } } catch { }"`) do (
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
        call :write_cursor_argv
        if errorlevel 1 (
            echo       [WARN] Could not update Cursor argv.json automatically.
            call :log "Failed to update Cursor argv.json"
        ) else (
            echo       Prepared Cursor argv.json with remote-debugging-port=!CDP_PORT!
            call :log "Prepared Cursor argv.json with remote-debugging-port=!CDP_PORT!"
        )

        echo       Stopping non-ancestor Cursor processes...
        !PS_CMD! -Command "$ancestors = @(); $cur = $PID; while ($cur -and $cur -ne 0) { $ancestors += $cur; try { $p = (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $cur) -ErrorAction Stop).ParentProcessId; if ($p -eq $cur) { break }; $cur = $p } catch { break } }; Get-Process -Name 'Cursor' -ErrorAction SilentlyContinue | Where-Object { $ancestors -notcontains $_.Id } | ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } catch {} }" >nul 2>&1
        timeout /t 2 /nobreak >nul 2>&1

        echo       Launching Cursor visibly on workspace: !TARGET_REPO!
        call :launch_cursor_visible_silent

        echo       Waiting for Cursor CDP to become ready...
        set "CDP_READY=0"
        for /l %%i in (1,1,20) do (
            if !CDP_READY!==0 (
                timeout /t 2 /nobreak >nul 2>&1
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
call :reset_runtime_logs

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
    set "SERVER_COMMAND=call npm run dev"
) else (
    set "SERVER_COMMAND=node server.js"
)

echo ============================================
echo  Mode:       BROWSER
echo  Server:     !BROWSER_URL!
echo  Runtime:    !SERVER_MODE!
echo  Open UI:    !OPEN_BROWSER!
echo  Verify:     !VERIFY_STARTUP!
echo  Console:    !CONSOLE_MODE!
echo  Logs:       log.txt
echo ============================================
echo.

call :log "Starting browser mode with command: !SERVER_COMMAND!"
echo       Starting background server...
if /i "!SERVER_MODE!"=="dev" (
    echo       Hot reload: enabled ^(watching server.js and public/* via nodemon^).
    call :log "Hot reload enabled via npm run dev"
)
start /b /min "" cmd /c "cd /d ""%CD%"" && set PORT=!PORT! && set CR_SKIP_AUTO_LAUNCH=1 && set CR_TERMINAL_LOG=!CR_TERMINAL_LOG! && set CR_RESET_LOG_ON_START=0 && !SERVER_COMMAND! >nul 2>&1"

if "!VERIFY_STARTUP!"=="1" (
    call :verify_server_startup
    if errorlevel 1 (
        echo [ERROR] Startup verification failed. Check log.txt.
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

call :log "Host ready: !BROWSER_URL!"
if defined MOBILE_URL call :log "Mobile host ready: !MOBILE_URL!"
if "!CAN_CLEAR_SCREEN!"=="1" cls >nul 2>&1
echo Host: !BROWSER_URL!
if defined MOBILE_URL echo Mobile: !MOBILE_URL!
if "!KEEP_HOST_WINDOW!"=="1" (
    echo.
    echo       Launcher attached to host on port !PORT!.
    echo       Press Ctrl+C to close this launcher window.
    call :log "Launcher attached to host on port !PORT!"
    call :wait_for_host_stop
)
exit /b 0

:verify_server_startup
set "STARTUP_READY=0"
set "VERIFY_STATE="
set "APP_MODE="
set "APP_MODEL="
set "HAS_CHAT="
set "MOBILE_URL="
set "HTTP_ONLY_STREAK=0"

echo       Waiting for the server to report ready state...
for /l %%i in (1,1,45) do (
    set "VERIFY_RESULT="
    for /f "usebackq delims=" %%r in (`!PS_CMD! -Command "$ProgressPreference = 'SilentlyContinue'; try { $base = '!BROWSER_URL!'; $healthRaw = & curl.exe -ks ($base + '/health'); if ($LASTEXITCODE -ne 0 -or -not $healthRaw) { exit 0 }; $health = ConvertFrom-Json -InputObject $healthRaw; $stateRaw = & curl.exe -ks ($base + '/app-state'); if ($LASTEXITCODE -ne 0 -or -not $stateRaw) { exit 0 }; $state = ConvertFrom-Json -InputObject $stateRaw; $snapshotOk = $false; try { $snapshotRaw = & curl.exe -ks ($base + '/snapshot'); if ($LASTEXITCODE -eq 0 -and $snapshotRaw) { $snapshot = ConvertFrom-Json -InputObject $snapshotRaw; $snapshotOk = [bool]$snapshot.html } } catch { $snapshotOk = $false }; if ($health.status -eq 'ok' -and $health.cdpConnected -and $snapshotOk -and $state.editorFound) { Write-Output ('ready|' + $state.mode + '|' + $state.model + '|' + $state.hasChat) } elseif ($health.status -eq 'ok' -and $health.cdpConnected) { Write-Output ('connected|' + $state.mode + '|' + $state.model + '|' + $state.hasChat) } elseif ($health.status -eq 'ok') { Write-Output 'http' } } catch { }"`) do (
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

        if /i "!VERIFY_STATE!"=="http" (
            set /a HTTP_ONLY_STREAK+=1
        ) else (
            set "HTTP_ONLY_STREAK=0"
        )

        if !HTTP_ONLY_STREAK! GEQ 5 (
            goto verify_http_partial
        )
    )

    timeout /t 2 /nobreak >nul 2>&1
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

:verify_http_partial
echo       [WARN] HTTP server is up, but Cursor CDP is not ready yet.
echo              Opening the web UI anyway so the session can recover once Cursor appears.
echo              If needed, start Cursor manually and refresh the page after a few seconds.
call :log "Verification ended in http-only state"
exit /b 0

:verify_ready
for /f "usebackq delims=" %%u in (`!PS_CMD! -Command "$ProgressPreference = 'SilentlyContinue'; try { $response = & curl.exe -ks '!BROWSER_URL!/qr-info'; if ($LASTEXITCODE -eq 0 -and $response) { $r = ConvertFrom-Json -InputObject $response; if ($r.connectUrl) { $r.connectUrl } } } catch { }"`) do (
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

:ensure_https_certificates
if exist "certs\server.key" if exist "certs\server.cert" (
    echo       HTTPS certificates OK.
    call :log "HTTPS certificates OK"
    exit /b 0
)

echo       HTTPS certificates missing. Generating...
call :log "HTTPS certificates missing; generating"
call node generate_ssl.js
if errorlevel 1 (
    echo       [ERROR] Failed to generate HTTPS certificates.
    call :log "HTTPS certificate generation failed"
    exit /b 1
)

if exist "certs\server.key" if exist "certs\server.cert" (
    echo       HTTPS certificates ready.
    call :log "HTTPS certificates ready"
    exit /b 0
)

echo       [ERROR] HTTPS certificates were not created.
call :log "HTTPS certificates still missing after generation"
exit /b 1

:stop_workspace_servers
echo       Stopping existing Cursor Remote server processes for this workspace...
set "FOUND_WORKSPACE_PROCESS=0"
for /f "usebackq delims=" %%p in (`!PS_CMD! -Command "$workspace = [regex]::Escape((Get-Location).Path); $managedPorts = 3000..3005; $portPids = @(); try { $portPids = Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $managedPorts -contains $_.LocalPort } | Select-Object -ExpandProperty OwningProcess -Unique } catch { $portPids = @() }; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ( ((($_.CommandLine -match $workspace) -and ($_.CommandLine -match 'server\.js' -or $_.CommandLine -match 'nodemon' -or $_.CommandLine -match 'tauri-server\.mjs')) -or ($_.CommandLine -match 'watch-server\.ps1')) -or (($portPids -contains $_.ProcessId) -and ($_.CommandLine -match 'server\.js' -or $_.CommandLine -match 'nodemon' -or $_.CommandLine -match 'tauri-server\.mjs')) ) } | Select-Object -ExpandProperty ProcessId -Unique"`) do (
    if not "%%p"=="" (
        set "FOUND_WORKSPACE_PROCESS=1"
        echo         - PID %%p
        taskkill /PID %%p /T /F >nul 2>&1
        call :log "Stopped workspace server PID %%p"
    )
)
if "!FOUND_WORKSPACE_PROCESS!"=="0" echo         No existing workspace server process found.
exit /b 0

:ensure_json_utf8_no_bom
set "JSON_UTF8_FILE=%~1"
if not defined JSON_UTF8_FILE exit /b 0
if not exist "!JSON_UTF8_FILE!" exit /b 0
%PS_CMD% -Command ^
  "$path = $env:JSON_UTF8_FILE; " ^
  "$bytes = [System.IO.File]::ReadAllBytes($path); " ^
  "if ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) { " ^
  "  $text = [System.Text.Encoding]::UTF8.GetString($bytes, 3, $bytes.Length - 3); " ^
  "  $encoding = New-Object System.Text.UTF8Encoding($false); " ^
  "  [System.IO.File]::WriteAllText($path, $text, $encoding) " ^
  "}" >nul 2>&1
exit /b 0

:write_cursor_argv
%PS_CMD% -Command ^
  "$ErrorActionPreference = 'Stop'; " ^
  "$path = $env:ARGV_FILE; " ^
  "$dir = Split-Path -Parent $path; " ^
  "if (-not (Test-Path -LiteralPath $dir)) { [System.IO.Directory]::CreateDirectory($dir) | Out-Null }; " ^
  "$data = @{}; " ^
  "if (Test-Path -LiteralPath $path) { " ^
  "  try { " ^
  "    $existing = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json; " ^
  "    if ($existing) { foreach ($prop in $existing.PSObject.Properties) { $data[$prop.Name] = $prop.Value } } " ^
  "  } catch { $data = @{} } " ^
  "}; " ^
  "$data['remote-debugging-port'] = [int]$env:CDP_PORT; " ^
  "$json = $data | ConvertTo-Json -Depth 10; " ^
  "$encoding = New-Object System.Text.UTF8Encoding($false); " ^
  "[System.IO.File]::WriteAllText($path, $json, $encoding)" >nul 2>&1
exit /b !errorlevel!

:launch_cursor_visible_silent
if exist "%CURSOR_STDOUT_LOG%" del /f /q "%CURSOR_STDOUT_LOG%" >nul 2>&1
if exist "%CURSOR_STDERR_LOG%" del /f /q "%CURSOR_STDERR_LOG%" >nul 2>&1
%PS_CMD% -Command ^
  "$ErrorActionPreference = 'Stop'; " ^
  "$exe = $env:CURSOR_EXE; " ^
  "$workspace = $env:TARGET_REPO; " ^
  "$port = [string]$env:CDP_PORT; " ^
  "$stdout = $env:CURSOR_STDOUT_LOG; " ^
  "$stderr = $env:CURSOR_STDERR_LOG; " ^
  "Start-Process -FilePath $exe -ArgumentList @($workspace, ('--remote-debugging-port=' + $port)) -WorkingDirectory $workspace -WindowStyle Normal -RedirectStandardOutput $stdout -RedirectStandardError $stderr | Out-Null" >nul 2>&1
exit /b !errorlevel!

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

for /f "usebackq delims=" %%r in (`!PS_CMD! -Command "$ErrorActionPreference = 'Stop'; $cursorExe = $env:CURSOR_EXE; $workspace = $env:TARGET_REPO; $shell = New-Object -ComObject WScript.Shell; if ($shell.AppActivate('Cursor')) { Start-Sleep -Milliseconds 300; Write-Output 'focused'; exit 0 }; $proc = Start-Process -FilePath $cursorExe -ArgumentList @($workspace) -PassThru; Start-Sleep -Seconds 3; if ($shell.AppActivate($proc.Id)) { Write-Output 'launched'; exit 0 }; if ($shell.AppActivate('Cursor')) { Write-Output 'launched'; exit 0 }; Write-Output 'started'"`) do (
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
set "LOG_MESSAGE=%~1"
%PS_CMD% -Command "$path = $env:RUN_LOG; $line = '[' + (Get-Date).ToString('dd/MM/yyyy HH:mm:ss,ff') + '] ' + $env:LOG_MESSAGE; try { $fs = [System.IO.File]::Open($path, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite); $fs.Seek(0, [System.IO.SeekOrigin]::End) > $null; $bytes = [System.Text.Encoding]::UTF8.GetBytes($line + [Environment]::NewLine); $fs.Write($bytes, 0, $bytes.Length); $fs.Dispose() } catch { }" >nul 2>&1
set "LOG_MESSAGE="
exit /b 0

:reset_runtime_logs
if exist "%RUN_LOG%" del /f /q "%RUN_LOG%" >nul 2>&1
if exist "%RUN_LOG_OLD%" del /f /q "%RUN_LOG_OLD%" >nul 2>&1
if exist "%CURSOR_STDOUT_LOG%" del /f /q "%CURSOR_STDOUT_LOG%" >nul 2>&1
if exist "%CURSOR_STDERR_LOG%" del /f /q "%CURSOR_STDERR_LOG%" >nul 2>&1
exit /b 0

:pause_if_interactive
if "!CAN_PAUSE!"=="1" pause
exit /b 0

:wait_for_host_stop
set "HOST_STOP_MISSES=0"
:wait_for_host_stop_loop
timeout /t 2 /nobreak >nul 2>&1
call :is_port_free !PORT!
if "!PORT_FREE!"=="0" (
    set "HOST_STOP_MISSES=0"
    goto wait_for_host_stop_loop
)
set /a HOST_STOP_MISSES+=1
if !HOST_STOP_MISSES! LSS 3 goto wait_for_host_stop_loop
echo.
echo       Host on port !PORT! is no longer running. Closing launcher.
call :log "Host on port !PORT! stopped; launcher exiting"
exit /b 0
