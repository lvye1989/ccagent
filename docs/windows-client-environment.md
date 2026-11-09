# Windows 桌面客户端环境核对

本文根据当前打包脚本、已实现的桌面环境向导和工具实际调用整理。源码与专项验证不等于干净 Windows 安装验收；新安装包的产物及验收状态以当次发布记录为准。文档核对未读取真实 `.env` 凭据、安装软件或修改系统环境。

## 安装包负责的运行时

[`scripts/build-desktop.mjs`](../scripts/build-desktop.mjs) 固定下载并核对 SHA-256 的 Node.js **24.22.2 Windows x64** 完整归档，将 `node.exe`、npm/npx 和其他运行文件复制至 `backend/runtime`；后端与前端资源作为安装载荷打包。当前 `package.json` 固定 Electron **45.2.3**，Electron 自带 Chromium，客户端不要求另外安装 Chrome、WebView2 或全局 Node.js。

[`desktop/runtime.cjs`](../desktop/runtime.cjs) 用内置 `runtime/node.exe` 启动同一 Web/QueryEngine 后端，将该 runtime 目录放在子进程 PATH 最前。MCP 子进程继承此 PATH。因此 **安装版使用 npx 插件不需要再全局安装 Node/npm**；首次 npx 下载仍需要网络、可写缓存，以及该插件自己的依赖。用户直接在应用外终端运行 CLI/npm，属于另一种使用方式。

[`scripts/test-desktop.mjs`](../scripts/test-desktop.mjs) 已有内置 Node/npm 版本、子进程 PATH 与 MCP 使用内置 Node 的测试入口；这不等于每个 npm 插件均已验收。

## 核心条件与非核心工具

| 项目 | 当前实际要求 / 最小边界 | 证据及检测来源 |
| --- | --- | --- |
| Windows 与架构 | 当前发行脚本仅构建 Windows **x64**。系统检测接受 Windows 10 / Server 2016 起的 10.x 内核，建议 Windows 11；架构检查要求 x64。无 Win7/8 或原生 ARM64 发行承诺，也未验收 ARM 模拟或 Server 桌面环境 | 打包脚本指定 `Arch.x64`；环境管理器读取实际系统版本与机器架构。[Node 24.22.2 平台表](https://github.com/nodejs/node/blob/v24.22.2/BUILDING.md)及[Electron 平台变更](https://www.electronjs.org/docs/latest/breaking-changes)提供运行时基线，不等于本应用逐构建号验收。可选 WinGet 的系统门槛与应用启动门槛分开 |
| Windows PowerShell / DPAPI | 登录与本地凭据存储的必要系统能力。使用系统 Windows PowerShell 与当前 Windows 用户的 DPAPI；不能只装 PowerShell 7 就宣称满足此链路 | [`desktop/prerequisites.cjs`](../desktop/prerequisites.cjs)固定检测系统 PowerShell 并读取真实版本，要求主版本 ≥5；[`src/platform/secureStore.ts`](../src/platform/secureStore.ts)使用同一 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`。目录 `v1.0` 不代表实际版本。环境版本检查不代替账户流程的实际 DPAPI 读写 |
| 本机回环、账户网络、可写目录 | 需要能启动本机 `127.0.0.1` 服务、写入应用用户目录及所选工作区；登录需要访问已配置账户服务 | `desktop/runtime.cjs`、[`desktop/main.cjs`](../desktop/main.cjs)。仅核心启动不要求 Python、Git 或专业软件 |
| Git | Git 状态、仓库和依赖 Git 的插件功能按需使用；不是打开应用、登录和普通模型会话的统一前置条件 | 当前向导检测的是 **Git Bash**，不能用 `git.exe` 存在替代 GNU Bash 就绪；未另设 Git 最小版本或独立 Git 检测项 |
| Git Bash | 仅 Bash 工具及依赖 Bash 的脚本需要；Windows 原生操作可用 PowerShell 工具，缺失不阻止进入应用 | 环境管理器优先核对 `CCAGENT_BASH` / 合适的 `SHELL`，再查 Program Files / Program Files (x86) / LocalAppData 与 PATH，执行无 profile 的 `--version` 并识别 GNU Bash；排除 WSL 启动器。真实工具选择见 [`src/utils/bashExecutable.ts`](../src/utils/bashExecutable.ts)。自定义配置失效会明确提示，不用另一份安装掩盖 |
| ripgrep | 可选加速，不是全文/文件搜索的硬依赖 | [`grepTool.ts`](../src/tools/grepTool.ts)、[`globTool.ts`](../src/tools/globTool.ts)：`CCAGENT_RG` 或 PATH 的 `rg`，缺失时使用 JavaScript 文件遍历回退 |

## 按功能启用的环境

| 功能 | 需要的外部环境与已知版本边界 | 路径 / 就绪检测 |
| --- | --- | --- |
| PDF 转 Word、PDF 提取文本 | 向导现在按常用 MCP 的基础需求检测 Python **≥3.10**，但 PDF→Word 仍需 `pdf2docx`，文本提取仍需 PyMuPDF（发行名 `pymupdf`、导入名 `fitz`）或 `pdfplumber`。这些附加包没有自动安装或版本锁定，不能由 Python 就绪推断格式转换已可用 | 环境管理器解析真实 Python 版本；优先显式 `CCAGENT_PYTHON`，否则查 PATH、用户标准 Python 目录和 `py -3`，排除 WindowsApps 占位程序。转换器本身仍按 [`documentConversionRuntime.ts`](../src/tools/documentConversionRuntime.ts)的候选顺序运行，只有成功调用对应包才完成转换 |
| Word/Markdown 输出 PDF、DOCX 模板合并 | Windows Microsoft Word COM，或相应转换路径的 LibreOffice 回退；无需两者同时强装。DOCX/DOTX 模板合并走 Word | 同一转换模块：`CCAGENT_POWERSHELL` / `powershell.exe` 创建 Word COM；LibreOffice 查 `CCAGENT_LIBREOFFICE`、两个标准 Program Files 路径、PATH 的 `soffice.exe`。代码未规定 Word/LibreOffice 最小版本；找到 exe 不等于转换已通过 |
| 浏览器与计算机操作 | 内置 Web 界面已有 Chromium；使用外部浏览器、现有桌面窗口操作时才需要对应应用。没有要求必须安装 Chrome | [`browserSearchTool.ts`](../src/tools/browserSearchTool.ts) 的 Web 上下文可开内置网页面板，外部路径用系统 URL 关联；[`computerUseBackend.ts`](../src/tools/computerUseBackend.ts)依赖 Windows PowerShell、UI Automation/WinForms 及可交互桌面。窗口标题或进程名不能证明浏览器版本或页面可控 |
| Photoshop MCP | 本机 Photoshop；固定 npm 包 `@alisaitteke/photoshop-mcp@1.7.37`，默认由内置 npx 启动。未在代码中声明 Photoshop 最低版本，不把曾测试版本当兼容下限 | [`services/mcp/photoshop.ts`](../src/services/mcp/photoshop.ts)：`PHOTOSHOP_PATH` → `%ProgramFiles%\Adobe\Adobe Photoshop*\Photoshop.exe`；可用 `CCAGENT_PHOTOSHOP_MCP_ENTRY` 指定同名同版本的预装入口。只读连接测试读取真实 `app.version`，不把文件夹年份当软件版本 |
| ComfyUI 本地 MCP | ComfyUI 本体、模型、节点及对应驱动由用户管理。固定 `comfy-mcp==0.10.0` + `comfy-cli==1.18.0`，两包均要求 Python **≥3.10**；可由 uv 管理解释器，不要求全局 Python。GPU/显存要求取决于所选工作流，应用无统一硬件下限 | [`services/mcp/comfyui.ts`](../src/services/mcp/comfyui.ts)：已填绝对路径/`CCAGENT_COMFY_MCP_EXECUTABLE`、`CCAGENT_COMFY_CLI_EXECUTABLE`，或 `CCAGENT_UVX_EXECUTABLE` → `~/.local/bin/uvx.exe` → PATH。默认本机端口 8188；`server_info` 分别核对 MCP、comfy-cli 和 ComfyUI 运行状态，不混用三者版本 |
| SketchUp MCP | 桌面 SketchUp 和配套签名 RBZ、运行中的 loopback 桥；固定 `sketchup-mcp2==0.4.0`，要求 Python **≥3.10**。截图功能上游要求 SketchUp 2026+；基础连接不能据此一概要求 2026 | [`services/mcp/sketchup.ts`](../src/services/mcp/sketchup.ts)：显式入口/`CCAGENT_SKETCHUP_MCP_EXECUTABLE` → `%LOCALAPPDATA%\CCAGENT\integrations\sketchup-mcp\0.4.0\Scripts\sketchup-mcp2.exe` → uvx。默认端口 9876；检测握手兼容性和模型信息，分别展示 Python MCP/Ruby 插件版本；上游没报 SketchUp 应用版本时明确未知 |
| Rhino / Grasshopper | 当前原生 RhinoCommon 桥面向 Windows **Rhino 8**，由该软件和其插件提供对应能力；不是全体用户的安装前置项 | [`rhinoBackend.ts`](../src/tools/rhinoBackend.ts)使用 Windows PowerShell 桥；读取原生应用/桥接状态后才能认定可用。不能因系统 Python 存在便认为 Rhino 环境齐备 |
| Blender、其他 MCP | 当前应用目录没有专用 Blender 安装器或统一版本探测；按用户选择的具体 MCP、Blender 插件和启动方式配置，不能编造全局最低版本或自动认定就绪 | 通用 MCP 读取实际命令、参数和传输配置；应按明确的上游清单检测。远程 HTTP MCP 通常不要求本机 Node/Python，stdio MCP 则依其命令而定 |

固定 Python MCP 包的元数据来源：[comfy-mcp 0.10.0](https://pypi.org/project/comfy-mcp/0.10.0/)、[comfy-cli 1.18.0](https://pypi.org/project/comfy-cli/1.18.0/)、[sketchup-mcp2 0.4.0](https://pypi.org/project/sketchup-mcp2/0.4.0/)。专业软件的完整系统要求及许可证仍由其官方发行决定。

## 已实现的环境向导

主进程的 [`desktop/prerequisites.cjs`](../desktop/prerequisites.cjs)现在提供检测、安装任务状态、取消及固定官方帮助页面；[`desktop/main.cjs`](../desktop/main.cjs)负责调用与登录门禁，[`desktop/welcome.js`](../desktop/welcome.js)展示结果。旧 `checkCommand` 布尔检查已被该管理器替代。

当前界面固定 **5 项必需**：Windows 系统、x64 架构、系统 Windows PowerShell、内置 Node.js、内置 npm/npx；**3 项可选**：Git Bash、Python 3.10+、LibreOffice。检查报告包含检测时间、组件状态、可获得的真实版本及原因。Node 检查实际内置可执行文件，并在 manifest 有版本时核对一致；npm/npx 分别用内置 Node 运行各自 CLI。LibreOffice 当前只确认程序文件存在，不承诺转换结果；Python 附加包、专业软件和 MCP 不属于这 8 项自动检测范围。

启动先显示环境页，必需项检测通过后才启动本地后端。可选项缺失可继续；必需项不合格时停留在修复页，重新检测通过可重试启动。用户确认环境后记录 `desktop-state.json` 的 `environmentGuideVersion=1`，再进入登录或后续设置；`login`、`finish` 均重新检测，要求必需项就绪、无运行中的安装且已有该版本的环境确认。旧确认不会绕过新检测。菜单「文件 / 帮助 → 环境检测与安装」可重新打开环境页；账户首次设置标记仍单独保留。

## 按需安装与官方来源

检测优先复用现有环境，不执行项目脚本，不自行修改系统级 PATH。只有用户明确选择组件并点击安装才创建任务；一次仅一项，可取消，退出应用会取消任务并清理自身创建的任务进程。官方安装器如需调整用户环境，由其交互向导确认。安装器退出后重新检测，不能用退出码直接宣布安装成功。取消不会卸载已安装内容。

内置安装入口仅允许固定 WinGet ID：Git Bash 对应 `Git.Git`，Python 对应 `Python.Python.3.14`；Python 基础就绪门槛仍为 ≥3.10，不因检测到 3.10～3.13 就自动升级。安装前核对微软默认 `winget` 源的固定元数据，使用精确 ID、`--scope user`、`--interactive`、`--no-upgrade` 和 `--skip-dependencies`；未传自动接受许可/源协议、静默、强制安装或提升权限参数。安装器中的许可和用户级安装仍由用户确认，包不支持此范围或源无法核实时转向手动说明。

WinGet 不属于必需项；仅在系统满足其单独检测门槛（10.x build ≥17763 或更新系统）时探测。缺 WinGet 可打开[微软官方说明](https://learn.microsoft.com/windows/package-manager/winget/)。LibreOffice 仅打开[官方安装页](https://www.libreoffice.org/download/download-libreoffice/)，不由应用自动安装；Windows/PowerShell 与损坏的内置 Node/npm 提供官方说明或客户端修复提示，不通过全局 Node 安装掩盖损坏。

安装 IPC 只接受上述固定组件编号，帮助 IPC 只映射固定官方 HTTPS 页面；不接受任意 exe、shell、参数或下载 URL。调用仅信任向导窗口的主 frame 和精确本地文件 URL；preload 仅公开具名操作。检测/安装使用清理后的子进程环境与 TLS 校验，不传递模型凭据。Photoshop 固定 npm 包已有禁用安装脚本设置；其他 MCP 的依赖和许可须按其接入单独核对。

PDF Python 包、uv 和专业软件尚未纳入自动安装清单。后续如增加，应使用官方来源、独立 venv/uv 工具环境、经隔离验证的版本锁及哈希，不能默认最新版兼容全部功能或改动用户已有 ComfyUI。Python 3.14 安装成功也不代表 PDF 附加包或全部 MCP 已通过。

## 验证范围

本轮源码提供 [`test-desktop-prerequisites.mjs`](../scripts/test-desktop-prerequisites.mjs)的注入式检测/安装状态专项、[`test-desktop-setup-ipc.mjs`](../scripts/test-desktop-setup-ipc.mjs)的 VM 来源与门禁专项，以及 [`test-desktop-welcome-ui.mjs`](../scripts/test-desktop-welcome-ui.mjs)的向导 DOM 专项。它们检查固定参数、就绪判定、错误/取消状态及页面行为；mock/VM 验证不会启动真实 WinGet 安装，不能替代安装结果验收。

干净 Windows x64 安装验收仍待完成，需覆盖：无全局 Node/npm、缺 Git/Python 时的核心登录与对话、内置 npx 插件、实际 WinGet 交互/许可/用户级范围、安装取消和失败、受限目录、重启及卸载保留数据。打包成功或现有机器通过专项均不等于这些场景已经通过。
