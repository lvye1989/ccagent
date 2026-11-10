import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { Duplex } from "node:stream";

// Each probe starts before imports capture inherited proxy variables. All
// passwords, servers and accounts below are disposable loopback fixtures.
if (process.argv[2] === "--probe") {
  const { PlatformAccountClient } = await import("../platform/accountClient.js");
  const { SecureCredentialStore } = await import("../platform/secureStore.js");
  const { platformRequest } = await import("../platform/transport.js");
  const { nativeNetworkAgent, accountNetworkFailure } = await import("../platform/nativeNetwork.js");
  const target = process.env.NETWORK_FIXTURE_TARGET!;
  const action = process.argv[3];
  try {
    if (action === "timeout") {
      const original = https.request;
      https.request = ((url: URL, options: https.RequestOptions, callback: Parameters<typeof https.request>[2]) => original(url, { ...options, lookup: (() => {}) as NonNullable<https.RequestOptions["lookup"]> }, callback)) as typeof https.request;
      const started = Date.now();
      try { await new PlatformAccountClient(target, new SecureCredentialStore(path.join(process.env.CCAGENT_PLATFORM_HOME!, "unused-session.json"))).signUp("test@example.invalid", "fixture-only-password", "Network fixture"); }
      catch (error) { assert.equal((error as { code?: string }).code, "network_timeout"); assert(Date.now() - started >= 14500 && Date.now() - started < 20000); console.log(JSON.stringify({ ok: true })); process.exit(0); }
      assert.fail("Expected bounded DNS wait");
    } else if (action === "post") await new PlatformAccountClient(target, new SecureCredentialStore(path.join(process.env.CCAGENT_PLATFORM_HOME!, "unused-session.json"))).signUp("test@example.invalid", "fixture-only-password", "Network fixture");
    else if (action === "legacy") { Object.defineProperty(process.versions, "node", { value: "22.20.0" }); nativeNetworkAgent(new URL(target)); }
    else if (action === "legacy-direct") { Object.defineProperty(process.versions, "node", { value: "22.20.0" }); assert.equal(await (await platformRequest(new URL(process.env.NETWORK_FIXTURE_LOCAL!))).text(), "local-ok"); }
    else if (action === "switch") {
      const proxyAgent = nativeNetworkAgent(new URL(target));
      const inflight = await platformRequest(new URL(target + "/held"));
      const completed = inflight.text();
      await writeFile(path.join(process.env.CCAGENT_PLATFORM_HOME!, "platform", "network.json"), "{}");
      const directAgent = nativeNetworkAgent(new URL(target));
      assert.notEqual(proxyAgent, directAgent);
      const local = await platformRequest(new URL(process.env.NETWORK_FIXTURE_LOCAL! + "/release")); assert.equal(await local.text(), "local-ok");
      assert.equal(await completed, "secure-ok");
    } else if (action === "env-lock") {
      const original = nativeNetworkAgent(new URL(target));
      process.env.HTTPS_PROXY = "http://invalid-project-proxy.invalid:1";
      assert.equal(nativeNetworkAgent(new URL(target)), original);
      assert.equal(await (await platformRequest(new URL(target))).text(), "secure-ok");
    } else if (action === "worker-home") {
      process.env.CCAGENT_HOME = path.join(process.env.CCAGENT_PLATFORM_HOME!, "accounts", "isolated-worker");
      assert.equal(await (await platformRequest(new URL(target))).text(), "secure-ok");
    } else if (action === "global-direct") {
      http.globalAgent = new http.Agent({ proxyEnv: { HTTP_PROXY: process.env.NETWORK_FIXTURE_PROXY! } });
      await platformRequest(new URL("http://network-fixture.invalid"), { timeoutMs: 1000 });
    } else if (action === "classifications") {
      for (const [code, expected] of [["DEPTH_ZERO_SELF_SIGNED_CERT", "network_tls"], ["ENOTFOUND", "network_dns"], ["ETIMEDOUT", "network_timeout"], ["ECONNRESET", "network"]]) {
        const value = accountNetworkFailure(Object.assign(new Error("SECRET-RAW-ERROR"), { code }));
        assert.equal(value.code, expected); assert(!JSON.stringify(value).includes("SECRET"));
      }
    } else {
      const response = await platformRequest(new URL(action === "local" ? process.env.NETWORK_FIXTURE_LOCAL! : action === "http" ? "http://network-fixture.invalid" : target), { timeoutMs: 5000 });
      assert.equal(await response.text(), action === "local" ? "local-ok" : action === "http" ? "proxy-ok" : "secure-ok");
    }
    console.log(JSON.stringify({ ok: true }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, name: error instanceof Error ? error.name : "unknown", message: error instanceof Error ? error.message : "unknown", code: (error as { code?: string }).code }));
  }
} else {
  // Generate a self-signed test certificate at runtime. No private key is
  // stored in the repository, a fixture file or a certificate store.
  const der = (tag: number, bytes: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), bytes.length < 128 ? Buffer.from([bytes.length]) : (() => { let hex = bytes.length.toString(16); if (hex.length % 2) hex = "0" + hex; const length = Buffer.from(hex, "hex"); return Buffer.concat([Buffer.from([0x80 | length.length]), length]); })(), bytes]);
  const seq = (...items: Buffer[]) => der(0x30, Buffer.concat(items));
  const oid = (value: string): Buffer => {
    const parts = value.split(".").map(Number), bytes = [parts[0]! * 40 + parts[1]!];
    for (const part of parts.slice(2)) { let n = part; const encoded = [n & 127]; while ((n = Math.floor(n / 128)) > 0) encoded.unshift((n & 127) | 128); bytes.push(...encoded); }
    return der(6, Buffer.from(bytes));
  };
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const algorithm = seq(oid("1.2.840.113549.1.1.11"), der(5, Buffer.alloc(0)));
  const name = seq(der(0x31, seq(oid("2.5.4.3"), der(12, Buffer.from("network-fixture.invalid")))));
  const time = (value: Date) => der(0x17, Buffer.from(value.toISOString().replace(/\D/g, "").slice(2, 14) + "Z"));
  const tbs = seq(der(0xa0, der(2, Buffer.from([2]))), der(2, Buffer.from([1])), algorithm, name,
    seq(time(new Date(Date.now() - 86400000)), time(new Date(Date.now() + 86400000))), name, publicKey.export({ format: "der", type: "spki" }),
    der(0xa3, seq(seq(oid("2.5.29.19"), der(1, Buffer.from([255])), der(4, seq(der(1, Buffer.from([255]))))), seq(oid("2.5.29.17"), der(4, seq(der(0x82, Buffer.from("network-fixture.invalid"))))))));
  const certificate = seq(tbs, algorithm, der(3, Buffer.concat([Buffer.from([0]), sign("sha256", tbs, privateKey)])));
  const pem = "-----BEGIN CERTIFICATE-----\n" + certificate.toString("base64").match(/.{1,64}/g)!.join("\n") + "\n-----END CERTIFICATE-----\n";
  const folder = await mkdtemp(path.join(os.tmpdir(), "ccagent-network-"));
  const configFolder = path.join(folder, "platform"), configFile = path.join(configFolder, "network.json"), certFile = path.join(folder, "test-ca.pem");
  await mkdir(configFolder); await writeFile(certFile, pem);
  let connects = 0, posts = 0, proxyHttp = 0, checks = 0, dropPost = false;
  let heldResponse: http.ServerResponse | undefined;
  const sockets = new Set<Duplex>();
  const secure = https.createServer({ key: privateKey.export({ format: "pem", type: "pkcs8" }), cert: pem }, async (req, res) => {
    if (req.method === "POST") { posts++; for await (const _part of req) { /* Drain fixture body without logging it. */ } if (dropPost) { req.socket.destroy(); return; } res.setHeader("content-type", "application/json"); res.end("{}"); }
    else if (req.url === "/held") { heldResponse = res; res.write("secure-"); }
    else res.end("secure-ok");
  });
  secure.on("tlsClientError", () => {});
  const local = http.createServer((req, res) => { if (req.url === "/release") { heldResponse?.end("ok"); heldResponse = undefined; } res.end("local-ok"); });
  const proxy = http.createServer((_req, res) => { proxyHttp++; res.end("proxy-ok"); });
  const listen = (server: http.Server | https.Server) => new Promise<number>(resolve => server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port)));
  const securePort = await listen(secure), localPort = await listen(local), proxyPort = await listen(proxy);
  proxy.on("connect", (req, client, head) => {
    connects++; assert.equal(req.url, `network-fixture.invalid:${securePort}`);
    const upstream = net.connect(securePort, "127.0.0.1", () => { client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); });
    for (const socket of [client, upstream]) { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => { client.destroy(); upstream.destroy(); }); }
  });
  const baseEnv = { ...process.env, CCAGENT_PLATFORM_HOME: folder, NETWORK_FIXTURE_TARGET: `https://network-fixture.invalid:${securePort}`, NETWORK_FIXTURE_LOCAL: `http://127.0.0.1:${localPort}`, NETWORK_FIXTURE_PROXY: `http://127.0.0.1:${proxyPort}`, NODE_EXTRA_CA_CERTS: certFile };
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "NODE_USE_ENV_PROXY", "NODE_OPTIONS", "NODE_TLS_REJECT_UNAUTHORIZED"]) delete (baseEnv as NodeJS.ProcessEnv)[key];
  const run = async (action: string, env: NodeJS.ProcessEnv = {}) => {
    const result = await promisify(execFile)(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--probe", action], { cwd: process.cwd(), env: { ...baseEnv, ...env }, windowsHide: true, timeout: 25000, maxBuffer: 128 * 1024 });
    return JSON.parse(result.stdout.trim()) as { ok: boolean; name?: string; message?: string; code?: string };
  };
  const passed = (label: string) => { checks++; console.log("PASS " + label); };
  try {
    const config = { httpsProxy: `http://127.0.0.1:${proxyPort}`, httpProxy: `http://127.0.0.1:${proxyPort}` };
    await writeFile(configFile, JSON.stringify(config));
    assert((await run("get")).ok); assert.equal(connects, 1); passed("HTTPS actually traverses CONNECT with verified trusted TLS");
    assert((await run("post")).ok); assert.equal(posts, 1); passed("account POST traverses CONNECT exactly once");
    dropPost = true; const dropped = await run("post"); dropPost = false;
    assert.equal(dropped.ok, false); assert.equal(posts, 2); passed("a failed account POST is never retried");
    const beforeLocal = connects; assert((await run("local")).ok); assert.equal(connects, beforeLocal); assert.equal(proxyHttp, 0); passed("loopback remains direct despite explicit HTTP and HTTPS proxies");
    assert((await run("switch")).ok); passed("changing machine configuration selects a new direct agent without stopping old requests");
    await writeFile(configFile, JSON.stringify(config));
    const rejected = await run("get", { NODE_EXTRA_CA_CERTS: "", NODE_TLS_REJECT_UNAUTHORIZED: "0" });
    assert.equal(rejected.ok, false); assert.equal(rejected.name, "PlatformTransportError"); passed("untrusted TLS remains rejected even with inherited NODE_TLS_REJECT_UNAUTHORIZED=0");
    const accountRejected = await run("post", { NODE_EXTRA_CA_CERTS: "", NODE_TLS_REJECT_UNAUTHORIZED: "0" });
    assert.equal(accountRejected.code, "network_tls"); assert.equal(posts, 2); passed("account TLS failures have a safe certificate classification and never submit a password");
    const legacy = await run("legacy"); assert.equal(legacy.name, "NativeNetworkConfigurationError"); assert.match(legacy.message!, /22\.21/); passed("unsupported Node versions explicitly reject requested proxies");
    await rm(configFile);
    assert((await run("get", { HTTPS_PROXY: config.httpsProxy })).ok); passed("explicit startup HTTPS_PROXY works without NODE_USE_ENV_PROXY");
    assert((await run("env-lock", { HTTPS_PROXY: config.httpsProxy })).ok); passed("later project-like environment changes cannot redirect account traffic");
    assert((await run("http", { HTTP_PROXY: config.httpProxy })).ok); assert.equal(proxyHttp, 1); passed("explicit startup HTTP_PROXY supports non-loopback HTTP");
    await writeFile(configFile, JSON.stringify(config)); assert((await run("worker-home")).ok); passed("account workers retain platform-wide proxy configuration");
    await writeFile(configFile, JSON.stringify({ ...config, noProxy: "network-fixture.invalid" }));
    const beforeBypass = connects; assert.equal((await run("get")).ok, false); assert.equal(connects, beforeBypass); passed("NO_PROXY bypasses the configured proxy for matching hosts");
    await writeFile(configFile, JSON.stringify({ httpsProxy: "http://user:SECRET@proxy.invalid:1234" }));
    const invalid = await run("get"); assert.equal(invalid.ok, false); assert.equal(invalid.name, "NativeNetworkConfigurationError"); assert(!JSON.stringify(invalid).includes("SECRET")); passed("invalid credential-bearing proxy configuration fails safely");
    await writeFile(configFile, JSON.stringify({ httpsProxy: "https://127.0.0.1:1" }));
    const secureProxy = await run("get", { NODE_TLS_REJECT_UNAUTHORIZED: "0" }); assert.equal(secureProxy.name, "NativeNetworkConfigurationError"); passed("HTTPS-scheme proxy is safely rejected instead of inheriting insecure outer TLS");
    await writeFile(configFile, "{}"); const beforeDirect = proxyHttp; assert.equal((await run("global-direct")).ok, false); assert.equal(proxyHttp, beforeDirect); passed("explicit direct configuration ignores global proxy agents");
    assert((await run("legacy-direct")).ok); passed("older Node versions retain direct loopback compatibility");
    await writeFile(configFile, "{}"); assert((await run("classifications")).ok); passed("DNS TLS timeout and connection messages contain no raw errors");
    assert((await run("timeout")).ok); passed("account total deadline covers DNS that never resolves");
  } finally {
    for (const socket of sockets) socket.destroy();
    for (const server of [proxy, secure, local]) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    await rm(folder, { recursive: true, force: true });
  }
  console.log(`Platform network: ${checks} isolated checks passed; no external account requests or persisted private keys.`);
}
