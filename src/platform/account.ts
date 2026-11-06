import { getCCAgentPath } from "../utils/paths.js";
import { getCCAgentHome } from "../utils/paths.js";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { AccountError, normalizePlatformOrigin, PlatformAccountClient, type AccountSession, type StoredAccountSession } from "./accountClient.js";
import { SecureCredentialStore } from "./secureStore.js";

type PlatformConfiguration = { origin: string };

export function getPlatformHome(): string {
  return path.resolve(process.env.CCAGENT_PLATFORM_HOME?.trim() || getCCAgentHome());
}

export function accountKey(userId: string): string {
  if (!userId || userId.length > 200) throw new AccountError("账户标识无效。", "invalid_response");
  return createHash("sha256").update(userId).digest("hex").slice(0, 32);
}

export function accountHome(base: string, userId: string): string {
  return path.join(path.resolve(base), "accounts", accountKey(userId));
}

const stores = new Map<string, {
  configuration: SecureCredentialStore<PlatformConfiguration>;
  session: SecureCredentialStore<StoredAccountSession>;
}>();

function accountStores() {
  const base = getPlatformHome();
  let entry = stores.get(base);
  if (!entry) {
    entry = { configuration: new SecureCredentialStore(path.join(base, "platform", "configuration.json")),
      session: new SecureCredentialStore(path.join(base, "platform", "session.json")) };
    stores.set(base, entry);
  }
  return entry;
}

function configurationStore(): SecureCredentialStore<PlatformConfiguration> {
  return accountStores().configuration;
}

export async function configurePlatform(origin: string): Promise<string> {
  const normalized = normalizePlatformOrigin(origin);
  await configurationStore().write({ origin: normalized });
  leases.clear();
  return normalized;
}

export async function getPlatformAccountClient(): Promise<PlatformAccountClient> {
  const configuration = await configurationStore().read();
  const origin = configuration?.origin ?? process.env.CCAGENT_CLOUD_URL?.trim();
  if (!origin) throw new AccountError("官方服务尚未配置。请先运行 ccagent account setup --server <服务地址>。", "configuration");
  if (typeof origin !== "string") throw new AccountError("账户服务配置格式错误。", "configuration");
  return new PlatformAccountClient(origin, accountStores().session);
}

const leases = new Map<string, { checkedAt: number; session: AccountSession }>();
const checks = new Map<string, Promise<AccountSession>>();

export async function hasStoredPlatformSession(): Promise<boolean> {
  return (await accountStores().session.revision()) !== null;
}

/** A short bounded lease coalesces parallel local requests; no offline grace. */
export async function requirePlatformAccount(maxAgeMs = 0): Promise<AccountSession> {
  const client = await getPlatformAccountClient();
  const revision = await accountStores().session.revision();
  const expectedId = process.env.CCAGENT_ACCOUNT_ID;
  const key = JSON.stringify([getPlatformHome(), client.origin, revision, expectedId]);
  const now = Date.now();
  const maximumAge = Math.max(0, Math.min(maxAgeMs, 1500));
  const lease = leases.get(key);
  if (maximumAge > 0 && lease && now >= lease.checkedAt && now - lease.checkedAt < maximumAge && Date.parse(lease.session.expiresAt) > now) {
    return structuredClone(lease.session);
  }
  let check = checks.get(key);
  if (!check) {
    check = client.requireSession().then(session => {
      if (expectedId && session.user.id !== expectedId) throw new AccountError("当前运行实例所属账户已改变，请重新打开应用。", "account_changed", 401);
      leases.set(key, { session, checkedAt: Date.now() });
      if (leases.size > 32) leases.delete(leases.keys().next().value!);
      return session;
    }).finally(() => checks.delete(key));
    checks.set(key, check);
  }
  return structuredClone(await check);
}

/** Keep machine-level login separate from user-scoped engine data. */
export async function enterPlatformAccount(): Promise<{ session: AccountSession; home: string }> {
  const base = getPlatformHome();
  const session = await requirePlatformAccount();
  const home = accountHome(base, session.user.id);
  await mkdir(home, { recursive: true, mode: 0o700 });
  process.env.CCAGENT_PLATFORM_HOME = base;
  process.env.CCAGENT_ACCOUNT_ID = session.user.id;
  process.env.CCAGENT_HOME = home;
  return { session, home };
}
