# 工具执行后的模型续接修复

2026-11-09：Word 和 PowerShell 工具已经完成，但后续官方模型请求失败时，界面会同时显示工具完成和整轮失败。本次修复针对 DeepSeek 工具续接协议，保留工具的真实执行状态。

- DeepSeek 流式响应保留供应商要求的 `reasoning_content`，只回传同一供应商、同一接口与模型的历史状态；旧会话补齐空字段，不伪造历史内容。
- 官方目录返回真实供应商标识；网关严格校验并转发显式 `thinking.type=enabled|disabled`。其他供应商沿用原参数。
- 官方流等待结果保存和结算后的自然 EOF，避免把正常完成误记为取消。
- 截断、损坏或不完整的工具参数不能进入工具执行；失败不会自动重跑已完成的工具。
- 官方输出额度无法提高时，跳过相同请求的无效 64K 重试，保留已有内容进入原有的有限续写流程。不修改管理员配置的价格、余额或输出额度。

协议依据：https://api-docs.deepseek.com/guides/thinking_mode/

可重复执行的回归测试：

```powershell
npm.cmd run test:providerstream
npm.cmd run test:platform-services
npm.cmd run test:tool-agent-recovery
npm.cmd run test:web-ui
cd cloud
npx.cmd tsx --test tests/deepseek-tool-replay.test.ts
```

自动回归使用隔离账户和模拟供应商，不产生真实模型费用。生产验收另外通过当前官方模型实际执行 Word 生成、PowerShell、子 Agent 读写、下一轮对话、关闭思考和旧历史兼容；验收文件和不含凭据的结果保存在忽略目录 `output/checks/live-tool-agent-20261109` 与 `output/checks/live-tool-agent-verification.json`。不要将 `.env`、账户会话、密钥存储或本地操作脚本提交到仓库。
