# CLI 与本地 Web 工具一致性

核查与验收日期：2026-11-10（北京时间）。

## 统一调用路径

在相同账户、工作区、模型设置、权限模式及已连接 MCP 下，CLI 与 Web 共用 QueryEngine、工具注册表、参数 schema、Agent 分派、Jev 决策、中央权限检查和实际工具执行器。普通 Web 对话不另建工具清单，也不使用替代执行器。临时聊天、团队开关与专项白板的工具范围仍按各自明确的会话设置生效。

`BrowserSearch` 的分派名称保持不变，CLI 和 Web 均显示为 **Jev Browser Search**。Jev 是它的决策关卡。

此前 Web 通过 `openUrlInWebPanel` 把该工具改成 iframe 导航，CLI 则启动系统浏览器。本次已删除该分叉和子 Agent 的对应传递。两端现在均经过同一单次授权，调用系统默认浏览器，再检查本机浏览器窗口。回执包含 `browser_surface=os_default_browser`。

`launch_status=accepted` 表示系统接受了打开请求，不表示页面内容已独立核实。后续网页交互继续使用共享的 ComputerObserve、ComputerActionGroup 和 ComputerAction。网页侧栏保留为用户手动预览入口。

## 后台 Agent 与提醒

后台 Agent 的完成和失败通知记录根会话 owner。Web 在空闲时自动续接原会话，保持团队 owner 限制，等待当前任务结束后再执行；其他会话不能消费它的通知。嵌套 Agent 继承根 owner，删除会话清理相应通知。

Workfriend 新计划保存 owner，Web 启动恢复计划，切换工作区重置定时器，关闭 worker 时清理定时器。旧的无 owner 提醒不会自动进入任意 Web 对话。CLI 保留单会话旧提醒兼容，同时也不能消费其他 owner 的通知。

## 验收

- 全局 `ccagent` 与当前 Web 使用同一构建；已备份旧全局安装，并校验两份 bundle 的 SHA-256 相同。
- 真实账户、真实模型和 Jev：按用户原有“完全访问”模式，CLI/Web 各调用一次 BrowserSearch 打开百度。两端均返回系统接受、原生浏览器 surface、Chrome 窗口检测；Web 没有 Agent iframe 导航事件。默认权限下，非交互 CLI 的权限拒绝也被保留，没有为测试绕过检查。
- `test:tool-parity`：default、auto、plan、full 下完整工具 schema 一致；Read、Write、stdio MCP 真实分派及权限结果一致；Auto 模式实际 Jev gate 的完整 decision policy 一致。账号和供应商均为本地隔离 fixture。
- `test:background-notifications`：8 项通过，覆盖跨会话隔离、后台成功/失败、忙碌延后、根 owner、提醒重启恢复和旧提醒兼容。
- BrowserSearch 17 项、Agent controls 54 项、Stage 20、Web HTTP、Web DOM、独立安装包/源码入口、21 项读图回归、TypeScript 检查和构建通过。

一致性测试已加入现有 Web 发布检查入口。本次只更新本地 Web 和全局 CLI，没有封装 EXE，也没有提交或推送 GitHub。
