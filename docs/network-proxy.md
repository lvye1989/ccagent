# 本机账户与官方网关代理

Web、CLI 与 Windows 客户端共用账户和官方网关的网络配置，包括附件上传。应用不会修改 Windows 系统代理、自动探测端口或读取项目 `.env` 来选择代理。

可在 `<CCAGENT_PLATFORM_HOME>/platform/network.json` 配置；没有设置该环境变量时使用当前 CCAGENT 主目录。示例中的端口需要换成自己代理软件实际启用的 HTTP 代理端口：

```json
{"httpsProxy":"http://127.0.0.1:实际端口"}
```

可选字段为 `httpProxy` 与 `noProxy`（以逗号分隔的主机列表）。代理地址仅支持 `http://` 的 HTTP/CONNECT 代理；HTTPS 目的站点仍在隧道内完整校验 TLS。暂不支持 `https://`、SOCKS 或带用户名、密码、查询参数、路径的代理地址。配置文件一旦存在，完整取代系统代理环境变量；填写 `{}` 可明确直连。修改配置后，新请求立即生效，已发出的请求继续使用原连接。

没有该文件时，使用应用启动时的 `HTTPS_PROXY`、`HTTP_PROXY`、`NO_PROXY`，并兼容优先级更高的小写变量；不要求设置 `NODE_USE_ENV_PROXY`。本机 `localhost`、`127.0.0.1` 和 `::1` 始终直连。系统环境变量改变后需要重启应用。

代理需要 Node.js 22.21+ 或 24.5+；Windows 客户端自带的运行环境已满足要求。旧版 Node 在没有代理时可继续使用，要求代理时会明确提示升级。

TLS 证书始终校验；登录、注册和付费请求不会因为网络失败自动重发。账户请求有 15 秒总时限，连接错误会区分证书、DNS 和超时，不展示底层请求、凭据或响应内容。

运行环境要求参考 [Node.js HTTP 代理文档](https://nodejs.org/api/http.html#built-in-proxy-support)。
