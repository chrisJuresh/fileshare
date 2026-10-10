# PC setup (Windows)

Sets up the Windows PC side of the outbox: Syncthing + SyncthingTray, a "Fileshare Outbox"
folder on the desktop, and pairing with the server. It is written so that a Claude Code session
on the PC (or a person) can follow it in **PowerShell**. Steps marked **(manual)** need clicks in
a GUI.

Fill in these values first (from the operator / `deploy.local.md`, never commit them):

| Placeholder | Meaning |
|---|---|
| `<server>` | SSH host for the server (e.g. an alias in `~/.ssh/config`) |
| `<repo dir>` | path of the fileshare checkout on the server |
| `<SERVER_LAN_IP>` | the server's LAN address (`LAN_IP` in its `.env`) |

How it behaves: anything you drop into **Fileshare Outbox** syncs to the server. Once the
server has the item safely in its library **and** in a snapshot, it removes it from the outbox,
and Syncthing then removes it from your PC too. A folder disappearing is the success signal.
The original files you copied from elsewhere are not touched.

## 1. Install (pinned versions)

```powershell
winget install --id Syncthing.Syncthing --version 2.1.6 --exact --accept-source-agreements --accept-package-agreements
winget install --id Martchus.syncthingtray --version 2.1.7 --exact --accept-source-agreements --accept-package-agreements
# Keep them from being upgraded by `winget upgrade --all` (upgrade deliberately, together with the server).
winget pin add --id Syncthing.Syncthing --version 2.1.6
winget pin add --id Martchus.syncthingtray --version 2.1.7
```

Open a **new** PowerShell window (so the `syncthing` and `syncthingtray` commands are on PATH), then:

```powershell
syncthing --version          # syncthing v2.1.6 …
```

## 2. Create the outbox folder

```powershell
$desktop = [Environment]::GetFolderPath('Desktop')
$outbox  = Join-Path $desktop 'Fileshare Outbox'
if ($desktop -like '*OneDrive*') {
  # Don't let OneDrive and Syncthing sync the same folder: keep the outbox outside OneDrive
  # and put a shortcut on the desktop instead.
  $outbox = Join-Path $env:USERPROFILE 'Fileshare Outbox'
  $ws = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut((Join-Path $desktop 'Fileshare Outbox.lnk'))
  $lnk.TargetPath = $outbox
  $lnk.Save()
}
New-Item -ItemType Directory -Force -Path $outbox | Out-Null
$outbox
```

## 3. First start and the PC's device ID

```powershell
syncthing generate                      # keys + config; Syncthing 2.x creates no default folder
syncthing paths                         # shows the config directory (normally %LOCALAPPDATA%\Syncthing)
$pcId = (syncthing device-id).Trim()
$pcId
Start-Process syncthing -ArgumentList 'serve','--no-browser' -WindowStyle Minimized
```

If Windows Defender Firewall asks, allow Syncthing on **Private** networks (manual).

Connect to the PC's own Syncthing REST API. Its API key is in the local `config.xml` and never
leaves the PC:

```powershell
$cfgFile = Join-Path $env:LOCALAPPDATA 'Syncthing\config.xml'   # adjust if `syncthing paths` says otherwise
[xml]$cfg = Get-Content -Raw $cfgFile
$h   = @{ 'X-API-Key' = $cfg.configuration.gui.apikey }
$api = 'http://127.0.0.1:8384'
Start-Sleep 5
Invoke-RestMethod "$api/rest/noauth/health"                       # status: OK
$pcIp = (Get-NetIPConfiguration | Where-Object IPv4DefaultGateway | Select-Object -First 1).IPv4Address.IPAddress
$pcIp
```

## 4. Pair on the server

```powershell
ssh <server> "cd <repo dir> && ./scripts/pair-pc.sh $pcId $pcIp"
```

The script adds this PC as device `pc`, shares folder `fileshare-outbox` with it, writes the
server's `.stignore`, records the PC's ID in the server's `.env` (edited in place; the previous
version is kept in `${APPDATA}/host-backups/<timestamp>/env.bak`) and recreates the `app` and
`restic` containers without rebuilding the image (a backup that happens to be running is
interrupted and retried). It prints:

- **Server device ID**: copy it into `$serverId` below
- **Folder ID**: `fileshare-outbox` (default)

It is safe to re-run (for example after the PC's address changes).

## 5. Configure the PC side

```powershell
$serverId = '<SERVER-DEVICE-ID printed by pair-pc.sh>'
$serverIp = '<SERVER_LAN_IP>'
$folderId = 'fileshare-outbox'
$json = @{ ContentType = 'application/json'; Headers = $h }

# LAN only, no telemetry / crash reports / auto-upgrade / relays / NAT traversal.
$opts = @{ globalAnnounceEnabled = $false; relaysEnabled = $false; natEnabled = $false
           urAccepted = -1; crashReportingEnabled = $false; autoUpgradeIntervalH = 0 }
Invoke-RestMethod -Method Patch "$api/rest/config/options" @json -Body ($opts | ConvertTo-Json)

# The server as a device, at its fixed LAN address.
$dev = Invoke-RestMethod "$api/rest/config/defaults/device" -Headers $h
$dev.deviceID  = $serverId
$dev.name      = 'fileshare-server'
$dev.addresses = @("tcp://${serverIp}:22000")
Invoke-RestMethod -Method Put "$api/rest/config/devices/$serverId" @json -Body ($dev | ConvertTo-Json -Depth 10)

# The outbox folder: Send & Receive, no versioning, watch for changes, shared with the server.
$f = Invoke-RestMethod "$api/rest/config/defaults/folder" -Headers $h
$f.id               = $folderId
$f.label            = 'Fileshare Outbox'
$f.path             = $outbox
$f.type             = 'sendreceive'
$f.fsWatcherEnabled = $true
$f.versioning.type  = ''
$f.devices          = @(@{ deviceID = $serverId })
Invoke-RestMethod -Method Put "$api/rest/config/folders/$folderId" @json -Body ($f | ConvertTo-Json -Depth 10)

# Same ignore patterns as the server (ignore lists are not synced, so both sides need them).
Start-Sleep 3
$ign = @{ ignore = @('(?d)desktop.ini', '(?d)Thumbs.db', '(?d).DS_Store', '(?d)~$*', '*.tmp') }
Invoke-RestMethod -Method Post "$api/rest/db/ignores?folder=$folderId" @json -Body ($ign | ConvertTo-Json)
Get-Content (Join-Path $outbox '.stignore')
```

About `.stignore`: `(?d)` lets Syncthing delete these junk files when their folder is removed
(after ingest), so Windows/Office leftovers don't keep empty folders alive. `*.tmp` is deliberately
**not** `(?d)`: a real `.tmp` file is never transferred, and it is never deleted for you either.

Check that the connection and folder are up (allow up to a minute):

```powershell
(Invoke-RestMethod "$api/rest/system/connections" -Headers $h).connections.$serverId.connected   # True
Invoke-RestMethod "$api/rest/db/status?folder=$folderId" -Headers $h | Select-Object state, errors
```

## 6. Tray icon and autostart

Autostart the tray at logon (scriptable):

```powershell
$startup = [Environment]::GetFolderPath('Startup')
$ws  = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut((Join-Path $startup 'Syncthing Tray.lnk'))
$lnk.TargetPath = (Get-Command syncthingtray).Source
$lnk.Save()
```

Let the tray start and stop Syncthing (manual, once):

1. Stop the temporary instance: `Stop-Process -Name syncthing`.
2. Start `syncthingtray`, right-click the tray icon → **Settings**.
3. **Syncthing → Launcher**: tick "Launch Syncthing when starting the tray icon". Executable:
   the output of `(Get-Command syncthing).Source`. Arguments: `serve --no-browser --no-restart`.
   (Syncthing 2.x only accepts double-dash flags; older single-dash defaults won't start.)
4. **Connection**: click "Apply settings from local config" (reads the local API key).
5. **General**: leave "Start the tray icon when the desktop environment launches" off; the
   Startup shortcut above does that.
6. Apply. The icon should turn to "idle / connected" within a minute.

## 7. Verify with synthetic data

```powershell
$t = Join-Path $outbox ('fileshare-test-' + (Get-Date -Format 'yyyyMMdd-HHmm'))
New-Item -ItemType Directory -Path $t | Out-Null
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
foreach ($i in 1..3) {
  $b = New-Object byte[] (8MB); $rng.GetBytes($b)
  [IO.File]::WriteAllBytes((Join-Path $t "sample-$i.bin"), $b)
}
Get-ChildItem $t | Get-FileHash -Algorithm SHA256 | Format-Table Hash, Path -AutoSize   # keep this output
Start-Sleep 30
Invoke-RestMethod "$api/rest/db/completion?folder=$folderId&device=$serverId" -Headers $h | Select-Object completion, needItems
```

Expected:

1. `completion` reaches 100 within seconds (LAN).
2. About **4–6 minutes** later the item shows as **ready** in the admin dashboard. The server
   waits until the folder has been unchanged for 2 minutes, hashes it (seconds for this size),
   requests a snapshot, waits the 2-minute snapshot debounce plus up to ~10 s for the snapshot
   runner to pick it up, and then the backup itself runs. Meanwhile it shows `stabilising`,
   `hashing`, then `snapshotting`.
3. The `fileshare-test-…` folder **disappears** from the outbox (on the server, then on the PC a
   few seconds later via Syncthing) **just before** the item turns ready: it is removed only once
   a snapshot covers it, and that is the last step.
4. Optional end-to-end check: create a share for it, download it in a browser, run
   `Get-FileHash` on the downloaded files and compare with the hashes above. Then delete the test
   item in the dashboard.

## Troubleshooting

- **Not connected:** check `$serverId` and that the server shows this PC's ID in its `.env`
  (`SYNCTHING_PC_DEVICE_ID`). The device address must be `tcp://<SERVER_LAN_IP>:22000`. The
  Windows network profile must be **Private** (`Get-NetConnectionProfile`), and Syncthing must be
  allowed through the firewall (`Get-NetFirewallRule -DisplayName '*syncthing*'`).
  `Test-NetConnection <SERVER_LAN_IP> -Port 22000` must succeed.
- **Folder stuck "Out of sync" / errors:** `Invoke-RestMethod "$api/rest/folder/errors?folder=$folderId" -Headers $h`.
  Typical causes: a file open in another program (Office lock), path too long, or permissions.
- **Item never becomes ready:** the server waits until the folder has been unchanged for 2 minutes
  and the PC reports 100%. Don't keep writing into an item's folder; copy it in complete
  (or build it elsewhere and move it in).
- **"Folder marker missing" (`.stfolder`):** it was deleted. Recreate it with
  `New-Item -ItemType Directory (Join-Path $outbox '.stfolder')`, then rescan:
  `Invoke-RestMethod -Method Post "$api/rest/db/scan?folder=$folderId" -Headers $h`.
- **Tray shows "disconnected" but Syncthing runs:** Settings → Connection → "Apply settings from
  local config".
- **Version mismatch:** keep the PC and server on the same Syncthing major version (2.x). Upgrade
  both deliberately (`winget pin remove …`, then `winget upgrade --id Syncthing.Syncthing --version <v>`).
- **Desktop is in OneDrive:** use the `%USERPROFILE%\Fileshare Outbox` variant from step 2 and
  re-run step 5 with the new `$outbox` path.
