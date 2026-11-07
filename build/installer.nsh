!include "nsDialogs.nsh"
!include "LogicLib.nsh"

; Asked before files are copied. Git and Hybrid sign in and create the chat repository during install.
; Pages, variables and functions stay in this macro. The uninstaller includes this file and does not insert it.
!macro customPageAfterChangeDir
  Var DeskStorage
  Var DeskImport
  Var DeskCursorFound
  Var DeskFound
  Var RadioGit
  Var RadioLocal
  Var RadioHybrid
  Var ImportBox

  Page custom DeskStorageCreate DeskStorageLeave
  Page custom DeskImportCreate DeskImportLeave

Function DeskStorageCreate
  !insertmacro MUI_HEADER_TEXT "Where should chats be stored?" "Git and Hybrid sync through a private GitHub repository. Local stays on this computer."
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateRadioButton} 0 0 100% 18u "Git - chats sync through a private GitHub repository"
  Pop $RadioGit
  ${NSD_AddStyle} $RadioGit ${WS_GROUP}
  ${NSD_CreateRadioButton} 0 22u 100% 18u "Local - chats stay on this computer"
  Pop $RadioLocal
  ${NSD_CreateRadioButton} 0 44u 100% 18u "Hybrid - chats sync through GitHub, and the other IDE keeps its files"
  Pop $RadioHybrid
  nsDialogs::Show
FunctionEnd

Function DeskStorageLeave
  ${NSD_GetState} $RadioGit $0
  ${If} $0 = ${BST_CHECKED}
    StrCpy $DeskStorage "github"
  ${Else}
    ${NSD_GetState} $RadioLocal $0
    ${If} $0 = ${BST_CHECKED}
      StrCpy $DeskStorage "local"
    ${Else}
      ${NSD_GetState} $RadioHybrid $0
      ${If} $0 = ${BST_CHECKED}
        StrCpy $DeskStorage "hybrid"
      ${Else}
        MessageBox MB_OK|MB_ICONEXCLAMATION "Choose Git, Local, or Hybrid."
        Abort
      ${EndIf}
    ${EndIf}
  ${EndIf}
FunctionEnd

Function DeskImportCreate
  !insertmacro MUI_HEADER_TEXT "Import from an AI IDE?" "Cursor chats can be copied in. Other editors are left as they are."
  StrCpy $DeskCursorFound "0"
  StrCpy $DeskFound ""
  ${If} ${FileExists} "$APPDATA\Cursor"
    StrCpy $DeskCursorFound "1"
    StrCpy $DeskFound "$DeskFound Cursor."
  ${EndIf}
  ${If} ${FileExists} "$APPDATA\Code"
    StrCpy $DeskFound "$DeskFound Visual Studio Code."
  ${EndIf}
  ${If} ${FileExists} "$APPDATA\Windsurf"
    StrCpy $DeskFound "$DeskFound Windsurf."
  ${EndIf}
  ${If} ${FileExists} "$APPDATA\Claude"
  ${OrIf} ${FileExists} "$PROFILE\.claude"
    StrCpy $DeskFound "$DeskFound Claude."
  ${EndIf}
  ${If} $DeskFound == ""
    StrCpy $DeskFound "No AI IDE was found on this computer."
  ${Else}
    StrCpy $DeskFound "Found:$DeskFound"
  ${EndIf}

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 24u "$DeskFound"
  Pop $0
  ${If} $DeskCursorFound == "1"
    ${NSD_CreateCheckbox} 0 28u 100% 18u "Import projects and chats from Cursor"
    Pop $ImportBox
  ${Else}
    ${NSD_CreateLabel} 0 28u 100% 24u "Nothing will be imported. You can add folders after AgenticOps Desk opens."
    Pop $0
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function DeskImportLeave
  StrCpy $DeskImport "0"
  ${If} $DeskCursorFound == "1"
    ${NSD_GetState} $ImportBox $0
    ${If} $0 = ${BST_CHECKED}
      StrCpy $DeskImport "1"
    ${EndIf}
  ${EndIf}
FunctionEnd

!macroend

!macro customInstall
  ${If} $DeskStorage == ""
    ; A silent install skips the pages. The app asks on first start instead.
  ${Else}
    CreateDirectory "$APPDATA\AgenticOps Desk"
    StrCpy $0 "false"
    ${If} $DeskImport == "1"
      StrCpy $0 "true"
    ${EndIf}
    FileOpen $1 "$APPDATA\AgenticOps Desk\install-choices.json" w
    FileWrite $1 "{$\"storage$\":$\"$DeskStorage$\",$\"importCursor$\":$0}"
    FileClose $1
    ${If} $DeskStorage != "local"
      DetailPrint "Signing in to GitHub, then creating the chat repository..."
    ${Else}
      DetailPrint "Saving where chats live..."
    ${EndIf}
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --apply-install' $0
    ${If} ${FileExists} "$APPDATA\AgenticOps Desk\install-result.txt"
      FileOpen $1 "$APPDATA\AgenticOps Desk\install-result.txt" r
      FileRead $1 $2
      FileClose $1
      DetailPrint $2
      Delete "$APPDATA\AgenticOps Desk\install-result.txt"
    ${EndIf}
  ${EndIf}
!macroend
