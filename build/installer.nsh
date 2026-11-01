!macro customInstall
  DetailPrint "Importing Cursor projects and chats..."
  ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --import-cursor'
!macroend
