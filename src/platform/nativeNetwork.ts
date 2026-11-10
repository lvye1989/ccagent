import http from "node:http";
import https from "node:https";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { getCCAgentHome } from "../utils/paths.js";

// Captured before account entrypoints load project configuration. Repositories
// must not change where account credentials or official service requests travel.
const inheritedProxy = Object.freeze({
  httpsProxy: process.env.https_proxy || process.env.HTTPS_PROXY,
  httpProxy: process.env.http_proxy || process.env.HTTP_PROXY,
  noProxy: process.env.no_proxy || process.env.NO_PROXY,
});
type NetworkConfiguration = { httpsProxy?: string; httpProxy?: string; noProxy?: string };
export class NativeNetworkConfigurationError extends Error {
  constructor(unsupported = false) {
    super(unsupported ? "应用代理需要 Node.js 22.21 或 24.5 及以上版本，请升级运行环境。"
      : "应用网络代理配置无效，请检查本机 platform/network.json 或系统代理环境变量。");
    this.name = "NativeNetworkConfigurationError";
  }
}

function proxyUrl(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.length > 2048 || /[\s\x00-\x1f\x7f]/.test(value)) throw new NativeNetworkConfigurationError();
  let url: URL;
  try { url = new URL(value); } catch { throw new NativeNetworkConfigurationError(); }
  // Native Node's HTTPS-proxy handshake can inherit an insecure TLS environment
  // independently of the target request. Only HTTP CONNECT proxies are accepted;
  // HTTPS destinations still receive end-to-end verified TLS inside the tunnel.
  if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new NativeNetworkConfigurationError();
  return url.origin;
}

function configuration(): NetworkConfiguration {
  const file = path.join(path.resolve(process.env.CCAGENT_PLATFORM_HOME?.trim() || getCCAgentHome()), "platform", "network.json");
  let value: unknown;
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw new NativeNetworkConfigurationError();
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") value = inheritedProxy;
    else throw new NativeNetworkConfigurationError();
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["httpsProxy", "httpProxy", "noProxy"].includes(key))) throw new NativeNetworkConfigurationError();
  const config = value as Record<string, unknown>;
  if (config.noProxy !== undefined && (typeof config.noProxy !== "string" || config.noProxy.length > 2048 || /[\x00-\x1f\x7f]/.test(config.noProxy))) throw new NativeNetworkConfigurationError();
  return { httpsProxy: proxyUrl(config.httpsProxy), httpProxy: proxyUrl(config.httpProxy), noProxy: (config.noProxy as string | undefined)?.split(",").map(item => item.trim()).join(",") };
}

const agents = new Map<string, http.Agent | https.Agent>();
function proxySupported(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  return major > 24 || major === 24 && minor >= 5 || major === 22 && minor >= 21;
}

/** Dedicated agents leave global fetch/MCP transports unchanged. Loopback is always direct. */
export function nativeNetworkAgent(url: URL): http.Agent | https.Agent {
  const config = configuration();
  const local = url.hostname.replace(/\.$/, "") === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  const proxy = local ? undefined : url.protocol === "https:" ? config.httpsProxy : config.httpProxy;
  if (proxy && !proxySupported()) throw new NativeNetworkConfigurationError(true);
  const key = JSON.stringify([url.protocol, proxy ?? "", proxy ? config.noProxy ?? "" : ""]);
  let agent = agents.get(key);
  if (!agent) {
    const options = { keepAlive: true, maxFreeSockets: 4, timeout: 5000,
      proxyEnv: proxy ? { HTTP_PROXY: config.httpProxy, HTTPS_PROXY: config.httpsProxy, NO_PROXY: config.noProxy } : {} };
    agent = url.protocol === "https:" ? new https.Agent(options) : new http.Agent(options);
    agents.set(key, agent);
    // Do not destroy evicted agents: an in-flight request may still own one.
    // Idle sockets expire after the bounded timeout above.
    if (agents.size > 16) agents.delete(agents.keys().next().value!);
  }
  return agent;
}

/** Only fixed classifications may cross the account boundary, never raw network errors. */
export function accountNetworkFailure(error: unknown): { message: string; code: string } {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (["CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"].includes(code)) {
    return { message: "账户服务的安全证书验证失败，请检查系统时间与可信证书配置。", code: "network_tls" };
  }
  if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) return { message: "无法解析账户服务地址，请检查 DNS 与应用代理设置后重试。", code: "network_dns" };
  if (["ETIMEDOUT", "ERR_SOCKET_CONNECTION_TIMEOUT", "CCAGENT_NETWORK_TIMEOUT"].includes(code)) return { message: "连接账户服务超时，请检查网络与应用代理设置后重试。", code: "network_timeout" };
  return { message: "暂时无法连接账户服务，请检查网络后重试。", code: "network" };
}
