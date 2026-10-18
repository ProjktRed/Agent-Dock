; Per-user installer (electron-builder NSIS, one-click, no admin rights).
; Installs to %LOCALAPPDATA%\Programs\AgentDock, apart from the "Agent Dock" folder that
; npm run release:local uses by default, so uninstalling a release never touches a developer install.
!macro preInit
  SetRegView 64
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Programs\AgentDock"
  SetRegView 32
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Programs\AgentDock"
!macroend
