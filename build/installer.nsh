!include "nsDialogs.nsh"
!include "LogicLib.nsh"

; Asked before files are copied. Git and Hybrid sign in and create the chat repository during install.
; Pages, variables and functions stay in this macro. The uninstaller includes this file and does not insert it.
!macro customPageAfterChangeDir
  Var DeskStorage
  Var DeskImport
  Var DeskCursorFound
  Var DeskFound
  Var DeskToolsFound
  Var DeskImportTools
  Var ToolsBox
  Var RadioGit
  Var RadioLocal
  Var RadioHybrid
  Var ImportBox
  Var DeskLocalModel
  Var LocalModelBox

  Page custom DeskStorageCreate DeskStorageLeave
  Page custom DeskImportCreate DeskImportLeave
  Page custom DeskLocalModelCreate DeskLocalModelLeave

Function DeskLocalModelCreate
  !insertmacro MUI_HEADER_TEXT "Set up a free local model?" "It writes short chat summaries on this computer, so long chats cost less to continue."
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateCheckbox} 0 0 100% 18u "Set up a local model: qwen2.5 1.5B (about 1 GB)"
  Pop $LocalModelBox
  ${NSD_Check} $LocalModelBox
  ${NSD_CreateLabel} 0 24u 100% 36u "The download starts in the background when AgenticOps Desk first opens. You can also do this later in Settings, AI models."
  Pop $0
  nsDialogs::Show
FunctionEnd

Function DeskLocalModelLeave
  StrCpy $DeskLocalModel "false"
  ${NSD_GetState} $LocalModelBox $0
  ${If} $0 = ${BST_CHECKED}
    StrCpy $DeskLocalModel "true"
  ${EndIf}
FunctionEnd

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
  !insertmacro MUI_HEADER_TEXT "Import from an AI IDE?" "Cursor, Claude Code and VS Code chats can be copied in. Windsurf is left as it is."
  StrCpy $DeskCursorFound "0"
  StrCpy $DeskToolsFound "0"
  StrCpy $DeskFound ""
  ${If} ${FileExists} "$APPDATA\Cursor"
    StrCpy $DeskCursorFound "1"
    StrCpy $DeskFound "$DeskFound Cursor."
  ${EndIf}
  ${If} ${FileExists} "$APPDATA\Code"
    StrCpy $DeskFound "$DeskFound Visual Studio Code."
    StrCpy $DeskToolsFound "1"
  ${EndIf}
  ${If} ${FileExists} "$APPDATA\Windsurf"
    StrCpy $DeskFound "$DeskFound Windsurf."
  ${EndIf}
  ${If} ${FileExists} "$APPDATA\Claude"
  ${OrIf} ${FileExists} "$PROFILE\.claude"
    StrCpy $DeskFound "$DeskFound Claude."
  ${EndIf}
  ${If} ${FileExists} "$PROFILE\.claude\projects"
    StrCpy $DeskToolsFound "1"
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
  ${EndIf}
  ${If} $DeskToolsFound == "1"
    ${NSD_CreateCheckbox} 0 50u 100% 18u "Import Claude Code terminal sessions and VS Code chats"
    Pop $ToolsBox
  ${EndIf}
  ${If} $DeskCursorFound != "1"
  ${AndIf} $DeskToolsFound != "1"
    ${NSD_CreateLabel} 0 28u 100% 24u "Nothing will be imported. You can add folders after AgenticOps Desk opens."
    Pop $0
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function DeskImportLeave
  StrCpy $DeskImport "0"
  StrCpy $DeskImportTools "false"
  ${If} $DeskCursorFound == "1"
    ${NSD_GetState} $ImportBox $0
    ${If} $0 = ${BST_CHECKED}
      StrCpy $DeskImport "1"
    ${EndIf}
  ${EndIf}
  ${If} $DeskToolsFound == "1"
    ${NSD_GetState} $ToolsBox $0
    ${If} $0 = ${BST_CHECKED}
      StrCpy $DeskImportTools "true"
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
    ${If} $DeskImportTools != "true"
      StrCpy $DeskImportTools "false"
    ${EndIf}
    ${If} $DeskLocalModel != "true"
      StrCpy $DeskLocalModel "false"
    ${EndIf}
    FileOpen $1 "$APPDATA\AgenticOps Desk\install-choices.json" w
    FileWrite $1 "{$\"storage$\":$\"$DeskStorage$\",$\"importCursor$\":$0,$\"importTools$\":$DeskImportTools,$\"localModel$\":$DeskLocalModel}"
    FileClose $1
    ${If} $DeskStorage != "local"
      DetailPrint "Signing in to GitHub, then creating the chat repository..."
    ${Else}
      DetailPrint "Saving where chats live..."
    ${EndIf}
    Delete "$APPDATA\AgenticOps Desk\install-result.txt"
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --apply-install' $0
    ${If} ${FileExists} "$APPDATA\AgenticOps Desk\install-result.txt"
      FileOpen $1 "$APPDATA\AgenticOps Desk\install-result.txt" r
      FileRead $1 $2
      FileClose $1
      DetailPrint $2
      Delete "$APPDATA\AgenticOps Desk\install-result.txt"
    ${EndIf}
    ${If} $0 <> 0
      Abort "The storage choice was not saved. Close AgenticOps Desk and run the installer again."
    ${EndIf}
  ${EndIf}
!macroend
