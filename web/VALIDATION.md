# Web 自定义功能验证

验证日期：2026-10-28（北京时间）。

工作文件夹选择器：新增目录浏览、路径跳转、常用位置/磁盘、最近项目、名称搜索、隐藏目录、空目录选择及 Windows 系统选择器。`test:web` 验证真实目录列表及中文/空格路径；`test:web-customization` 实际执行相对路径 Read，确认命中新选择的目录，并验证资料空间范围、项目 Agent 隔离与切回后会话恢复。`scripts/test-workspace-picker-ui.mjs` 在离线 DOM 中验证选择/确认、上一级、双击、搜索、错误恢复、取消、原生选择器返回/取消/失败、切换锁定及焦点恢复。Windows 原生组件通过 `powershell.exe -NoProfile -STA -File web/select-folder.ps1 -ValidateOnly` 加载检查；系统对话框外观尚未经人工核验。

| 用户要求 | 实现与验证依据 |
| --- | --- |
| 创建、编辑 Agent | 描述需求生成可编辑配置，保存至共享 Agent 目录；集成测试实际调用自定义 Agent，并验证编辑时保留额外 frontmatter |
| 添加 MCP 并启动程序 | URL、JSON、需求解析入口；集成测试添加真实 stdio 测试进程并成功发现 echo 工具 |
| 本地技能及启停 | 单文件导入、完整目录导入；集成测试验证 scripts 文件保留、关闭后模型/命令调用被拦截、重启后状态保留 |
| 设置与 LLM 联动 | 通用/模型/权限分类；测试保存模型、连接测试、首页选择器、CLI 调用及重启加载凭据；密钥不在配置查询响应中回显 |
| Agent Teams | 编辑角色、按任务生成团队、自动组队、配置启停、总开关、首页及对话选择器；集成测试实际执行团队、自动继续汇总、同名团队重复使用和对话关闭拦截 |
| 外部 RAG 端口 | 添加/编辑/启停/测试连接；通用检索协议及 KnowledgeSearch；集成测试验证鉴权、来源片段进入实际对话、关闭后拒绝检索 |

通过：TypeScript 类型检查、原有 Web 集成测试、新增 `test:web-customization`、技能及 Agent 开关测试、Agent Teams 基础测试、stage21 团队测试、环境变量加载测试。`test:web` 现在同时包含原有与新增 Web 集成测试。

离线前端：`scripts/test-web-ui.mjs` 在隔离 DOM 中使用本地 HTML/JS 和模拟 API，验证六类入口、生成/编辑/保存弹窗、技能开关、模型列表联动、团队选择、设置及 RAG 表单；生成文本按字面呈现。运行方式：`node scripts/test-web-ui.mjs <happy-dom/lib/index.js 的本机路径>`。这项检查不访问浏览器或本机 Web 服务。

本机实测：新版服务在 `http://127.0.0.1:4174` 返回健康状态；现有 DeepSeek 连接测试返回 `OK`，自然语言生成 Agent 配置成功。测试未创建个人 Agent、团队或知识库，也未改写个人密钥。

验证限制：Chrome 访问授权被拒绝，因此没有进行浏览器视觉检查。旧 stage20 扩展测试的默认临时目录位于用户目录 Git 仓库之内，导致“仓库外目录”假设失效；改用仓库外临时目录时又受到 Windows `EBUSY` 清理锁影响，不能将其计为全套通过。新增团队端到端测试及 stage21 均通过。
