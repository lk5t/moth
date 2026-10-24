; MOTH installer hooks (Tauri NSIS).
;
; Claude Desktop / Claude Code start their own copy of moth-core.exe (the MCP server) from the install folder.
; Tauri's installer closes MOTH.exe, but not those copies, so an update failed with
; "Error opening file for writing: ...\moth-core.exe". Stop them first. Memories are safe: every write is a
; committed SQLite transaction (WAL), and Claude starts the server again on its next use.

!macro MOTH_STOP_ENGINES
  DetailPrint "Stopping MOTH engine copies started by Claude..."
  nsExec::Exec 'taskkill /F /T /IM moth-core.exe'
  Pop $0
  Sleep 800
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro MOTH_STOP_ENGINES
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro MOTH_STOP_ENGINES
!macroend
