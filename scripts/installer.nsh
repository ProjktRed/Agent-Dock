; Per-user installer (electron-builder NSIS, one-click, no admin rights).
; Installs to %LOCALAPPDATA%\Programs\AgentDock, apart from the "Agent Dock" folder that
; npm run release:local uses by default, so uninstalling a release never touches a developer install.
!macro preInit
  SetRegView 64
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Programs\AgentDock"
  SetRegView 32
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Programs\AgentDock"
!macroend

; A real uninstall removes the app's tasks under Task Scheduler's "\Agent Dock\" folder (scheduled runs
; while Agent Dock is closed), then the folder itself once it is empty. Only tasks that launch an exe in
; this install folder go, so a developer install's tasks stay. Skipped when the uninstaller runs during an
; update (--updated): the app keeps its tasks and syncs them on its next launch. Per-user tasks, so no admin
; rights are needed; best effort, so a failure never stops the uninstall. The install folder reaches
; PowerShell through an environment variable, which keeps any quote in the path out of the script.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    Push $0
    System::Call 'kernel32::SetEnvironmentVariable(t "AGENT_DOCK_UNINSTALL_DIR", t "$INSTDIR")'
    StrCpy $0 "$$d = $$env:AGENT_DOCK_UNINSTALL_DIR.TrimEnd('\') + '\'; "
    StrCpy $0 "$0Get-ScheduledTask -TaskPath '\Agent Dock\' -ErrorAction SilentlyContinue | "
    StrCpy $0 "$0Where-Object { @($$_.Actions | Where-Object { $$_.Execute -and $$_.Execute.Trim([char]34).StartsWith($$d, [StringComparison]::OrdinalIgnoreCase) }).Count } | "
    StrCpy $0 "$0Unregister-ScheduledTask -Confirm:$$false -ErrorAction SilentlyContinue; "
    StrCpy $0 "$0try { $$s = New-Object -ComObject Schedule.Service; $$s.Connect(); $$f = $$s.GetFolder('\Agent Dock'); "
    StrCpy $0 "$0if ($$f.GetTasks(1).Count -eq 0 -and $$f.GetFolders(0).Count -eq 0) { $$s.GetFolder('\').DeleteFolder('Agent Dock', 0) } } catch {}"
    nsExec::Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$0"'
    Pop $0
    Pop $0
  ${endIf}
!macroend
