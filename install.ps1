# Installs the factory into the current Windows user's Claude Code setup. Idempotent; re-run after editing anything here.
#   powershell -ExecutionPolicy Bypass -File install.ps1 [-NoAgents] [-NoHooks] [-NoDashboard] [-RemoveHooks]
#
#  1. .claude\agents\*.md and .claude\skills\factory  -> %USERPROFILE%\.claude\ (agents and skill, overwritten)
#  2. hooks\*                                          -> %USERPROFILE%\.claude\factory\ (telemetry, approval gate, dashboard)
#  3. hook entries merged into %USERPROFILE%\.claude\settings.json and .claude-personal\settings.json (whichever exist)
#  4. dashboard registered as the \ClaudeFactoryDashboard logon task on http://127.0.0.1:7777
# CLAUDE.global.md is never copied: merge it into your own ~/.claude/CLAUDE.md by hand.
param([switch]$NoAgents, [switch]$NoHooks, [switch]$NoDashboard, [switch]$RemoveHooks)
$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$claude = Join-Path $env:USERPROFILE '.claude'
$dst = Join-Path $claude 'factory'
$node = (Get-Command node -ErrorAction Stop).Source

if (-not $NoAgents) {
  New-Item -ItemType Directory -Force (Join-Path $claude 'agents'), (Join-Path $claude 'skills\factory') | Out-Null
  Copy-Item (Join-Path $repo '.claude\agents\*.md') (Join-Path $claude 'agents') -Force
  Copy-Item (Join-Path $repo '.claude\skills\factory\SKILL.md') (Join-Path $claude 'skills\factory\SKILL.md') -Force
  Write-Host "Agents and the factory skill copied to $claude"
}
if ($NoHooks) { return }

$src = Join-Path $repo 'hooks'
$files = 'lib.js', 'telemetry.js', 'approval-gate.js', 'protected.json', 'pricing.json', 'install-hooks.js', 'work.js',
         'dashboard\server.js', 'dashboard\board.js', 'dashboard\index.html', 'dashboard\run-hidden.vbs'
New-Item -ItemType Directory -Force (Join-Path $dst 'dashboard'), (Join-Path $dst 'data') | Out-Null
foreach ($f in $files) { Copy-Item (Join-Path $src $f) (Join-Path $dst $f) -Force }
Write-Host "Copied $($files.Count) files to $dst"
# boards.json is yours to edit (projects, repos, integration branch): seeded once from the example, never overwritten
$boards = Join-Path $dst 'boards.json'
if (-not (Test-Path $boards)) { Copy-Item (Join-Path $src 'boards.example.json') $boards; Write-Host "Seeded $boards from boards.example.json; edit it" }

foreach ($dir in '.claude', '.claude-personal') {
  $settings = Join-Path $env:USERPROFILE "$dir\settings.json"
  if (-not (Test-Path $settings)) { Write-Host "skip: $settings not found"; continue }
  if (-not (Test-Path "$settings.bak-factory")) { Copy-Item $settings "$settings.bak-factory" }
  $hookArgs = @((Join-Path $dst 'install-hooks.js'), $settings, $dst)
  if ($RemoveHooks) { $hookArgs += '--remove' }
  & $node @hookArgs
  if ($LASTEXITCODE -ne 0) { throw "hook merge failed for $settings" }
}

if ($NoDashboard -or $RemoveHooks) { return }
$task = 'ClaudeFactoryDashboard'
$vbs = Join-Path $dst 'dashboard\run-hidden.vbs'
# stop a previous dashboard so the new code is served; refuse if something else owns the port
$listen = Get-NetTCPConnection -LocalPort 7777 -State Listen -ErrorAction SilentlyContinue
foreach ($c in $listen) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"
  if ($p.CommandLine -like '*factory*server.js*') { Stop-Process -Id $p.ProcessId -Force }
  else { throw "Port 7777 is used by another program ($($p.Name), pid $($p.ProcessId)); dashboard not started." }
}
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "//B //Nologo `"$vbs`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$opts = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $opts -Description 'Claude factory dashboard on http://127.0.0.1:7777' -Force | Out-Null
Start-ScheduledTask -TaskName $task
Start-Sleep -Seconds 2
if (Get-NetTCPConnection -LocalPort 7777 -State Listen -ErrorAction SilentlyContinue) { Write-Host 'Dashboard: http://127.0.0.1:7777' }
else { Write-Warning "Dashboard did not start; see $dst\data\dashboard.log" }
