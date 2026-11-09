; Preflight runs before copying application files, including silent upgrades.
!macro customInit
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP|MB_OK "CCAGENT 需要 Windows 10 / Server 2016 或更高版本。请先升级系统，再运行安装程序。"
    SetErrorLevel 1633
    Quit
  ${EndIf}
  ${IfNot} ${IsNativeAMD64}
    MessageBox MB_ICONSTOP|MB_OK "此 CCAGENT 安装包适用于 Windows x64。当前处理器架构不在本安装包的支持范围内。"
    SetErrorLevel 1633
    Quit
  ${EndIf}
!macroend

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "欢迎安装 CCAGENT"
  !define MUI_WELCOMEPAGE_TEXT "你的 AI 桌面工作区。$\r$\n$\r$\n安装步骤：$\r$\n  1. 阅读许可与使用说明$\r$\n  2. 选择安装范围及位置$\r$\n  3. 检查运行环境，安装程序和快捷方式$\r$\n  4. 启动环境向导，按需安装扩展组件$\r$\n  5. 登录并选择工作文件夹及模型服务$\r$\n$\r$\n安装包已包含 Node.js、npm / npx 和浏览器内核。普通对话无需另装 Python 或 Git Bash。$\r$\n$\r$\n点击“下一步”继续。"
  !insertmacro MUI_PAGE_WELCOME
!macroend

!ifndef BUILD_UNINSTALLER
  Var ccagentPowerShellStatus
!endif

!macro customPageAfterChangeDir
  Page custom ccagentReadyPage
  Function ccagentRefreshEnvironment
    IfFileExists "$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" powershellFound powershellMissing
    powershellFound:
      ${NSD_SetText} $ccagentPowerShellStatus "Windows PowerShell：已找到系统组件，首次启动时将验证能否运行。"
      Return
    powershellMissing:
      ${NSD_SetText} $ccagentPowerShellStatus "Windows PowerShell：未找到。请修复系统组件，修复后重新检测；必需组件不可用时将无法继续登录。"
  FunctionEnd

  Function ccagentPowerShellHelp
    Pop $0 ; nsDialogs passes the clicked control handle.
    ExecShell "open" "https://learn.microsoft.com/powershell/scripting/windows-powershell/install/windows-powershell-system-requirements"
  FunctionEnd

  Function ccagentRefreshEnvironmentClick
    Pop $0
    Call ccagentRefreshEnvironment
  FunctionEnd

  Function ccagentReadyPage
    !insertmacro MUI_HEADER_TEXT "运行环境与安装准备" "检查必需环境；扩展工具将在首次启动向导中按需安装。"
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 0 100% 11% "安装位置：$INSTDIR"
    Pop $0
    ${NSD_CreateLabel} 0 13% 100% 9% "系统检查通过：Windows 10 或更高版本，x64 架构。"
    Pop $0
    ${NSD_CreateLabel} 0 24% 100% 18% "正在检查系统 Windows PowerShell…"
    Pop $ccagentPowerShellStatus
    ${NSD_CreateButton} 0 44% 92u 16u "系统修复说明"
    Pop $0
    ${NSD_OnClick} $0 ccagentPowerShellHelp
    ${NSD_CreateButton} 101u 44% 76u 16u "重新检测"
    Pop $0
    ${NSD_OnClick} $0 ccagentRefreshEnvironmentClick
    ${NSD_CreateLabel} 0 59% 100% 16% "安装包自带：Node.js、npm / npx、桌面浏览器内核。$\r$\n内置环境损坏时，请修复或重新安装客户端。升级保留用户配置。"
    Pop $0
    ${NSD_CreateLabel} 0 78% 100% 22% "可选：Git Bash（Bash 工作流）、Python（部分 MCP / 文档工具）、LibreOffice（文档转换）。$\r$\n安装后启动环境向导，可按需安装、打开官网或重新检测；也可跳过可选组件。"
    Pop $0
    Call ccagentRefreshEnvironment
    GetDlgItem $0 $HWNDPARENT 1
    ${NSD_SetText} $0 "安装(&I)"
    nsDialogs::Show
  FunctionEnd
!macroend

!define MUI_FINISHPAGE_TITLE "CCAGENT 安装完成"
!define MUI_FINISHPAGE_TEXT "CCAGENT 已安装到你的电脑。$\r$\n$\r$\n接下来：$\r$\n  1. 启动 CCAGENT，完成环境检测$\r$\n  2. 按需安装 Git Bash / Python，或跳过可选组件$\r$\n  3. 登录并选择工作文件夹$\r$\n  4. 接入模型，开始第一项任务$\r$\n$\r$\n以后可从应用菜单“环境检测与安装”重新打开向导。"
!define MUI_FINISHPAGE_RUN_TEXT "启动 CCAGENT 并检查运行环境"
