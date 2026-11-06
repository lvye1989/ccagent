!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "欢迎安装 CCAGENT"
  !define MUI_WELCOMEPAGE_TEXT "你的 AI 桌面工作区。$\r$\n$\r$\n本向导将帮助你完成 CCAGENT 的安装。$\r$\n$\r$\n安装步骤：$\r$\n  1. 阅读许可与使用说明$\r$\n  2. 选择安装范围及安装位置$\r$\n  3. 安装并创建应用快捷方式$\r$\n  4. 启动后选择工作文件夹、接入模型$\r$\n$\r$\n应用已包含 Node.js 与 npm，无需手动启动服务。$\r$\n$\r$\n点击“下一步”继续。"
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customPageAfterChangeDir
  Page custom ccagentReadyPage
  Function ccagentReadyPage
    !insertmacro MUI_HEADER_TEXT "即将完成安装准备" "确认以下信息，然后点击“安装”。"
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 5u 100% 18u "CCAGENT · Windows 桌面版"
    Pop $0
    ${NSD_CreateLabel} 0 31u 100% 33u "安装位置：$\r$\n$INSTDIR"
    Pop $0
    ${NSD_CreateLabel} 0 73u 100% 27u "安装后可从桌面或开始菜单打开 CCAGENT。$\r$\n首次启动将引导你选择工作文件夹并配置 AI 模型。"
    Pop $0
    ${NSD_CreateLabel} 0 113u 100% 42u "升级会替换程序文件；已保存的用户配置与工作文件会保留。$\r$\nAPI 服务由你自行配置，部分 MCP / Python / Rhino 工具需要额外环境。$\r$\n请等待安装完成，再关闭本向导。"
    Pop $0
    GetDlgItem $0 $HWNDPARENT 1
    ${NSD_SetText} $0 "安装(&I)"
    nsDialogs::Show
  FunctionEnd
!macroend

!define MUI_FINISHPAGE_TITLE "CCAGENT 安装完成"
!define MUI_FINISHPAGE_TEXT "CCAGENT 已安装到你的电脑。$\r$\n$\r$\n接下来：$\r$\n  1. 启动 CCAGENT$\r$\n  2. 选择工作文件夹$\r$\n  3. 添加模型配置并测试连接$\r$\n  4. 开始第一项任务$\r$\n$\r$\n以后可通过桌面快捷方式再次打开应用。"
!define MUI_FINISHPAGE_RUN_TEXT "立即启动 CCAGENT"
