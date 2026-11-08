import { lstat, readFile } from "node:fs/promises";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getCCAgentHome } from "../utils/paths.js";
import { accountHome, getPlatformHome } from "./account.js";
import { normalizePlatformOrigin } from "./accountClient.js";
import { SecureCredentialStore } from "./secureStore.js";
import { priceDefinition } from "./pricingDefinition.js";

export const platformKeyPattern = /^ccagent_[A-Za-z0-9_-]{43}$/;
export const officialRoles = ["main", "image", "decision", "search", "voice"] as const;
export type OfficialRole = typeof officialRoles[number];
export const officialModelPrefix = "ccagent:";
const routeId = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,79}$/);
const rolesSchema = z.object({ main: routeId.optional(), image: routeId.optional(), decision: routeId.optional(), search: routeId.optional(), voice: routeId.optional() }).strict();
export const serviceRouteSchema = z.object({
  id: routeId, name: z.string().min(1).max(100),
  service: z.enum(["chat", "vision", "decision", "search", "voice"]),
  protocol: z.enum(["openai-chat", "openai-responses", "jev-decisions", "tavily", "bocha", "dashscope-tts"]),
  pricing: z.object({ currency: z.enum(["CNY", "USD"]), definition: priceDefinition, markup: z.literal("1.3"),
    usdCny: z.string().nullable().optional(), version: z.number().int().positive(), sourceUrl: z.url().refine(value => new URL(value).protocol === "https:"), fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional() }),
  limits: z.object({ contextWindow: z.number().int().min(128).max(4000000), maxOutputTokens: z.number().int().min(1).max(1000000), maxImages: z.number().int().min(0).max(600), fallbackRouteId: routeId.nullable().optional(), fallbackEnabled: z.boolean().default(false) }),
});
export type OfficialServiceRoute = z.infer<typeof serviceRouteSchema>;
export type ServiceRoles = z.infer<typeof rolesSchema>;
const catalogDefaultsSchema = z.object({ chat: routeId.nullable().optional(), vision: routeId.nullable().optional(), decision: routeId.nullable().optional(), search: routeId.nullable().optional(), voice: routeId.nullable().optional() }).strict();
export function catalogDefaultRoles(input: unknown, routes: OfficialServiceRoute[]): ServiceRoles {
  if (input === undefined) return {}; // Older services may omit recommendations entirely.
  const defaults = catalogDefaultsSchema.parse(input);
  const mapping = { main: 'chat', image: 'vision', decision: 'decision', search: 'search', voice: 'voice' } as const;
  return validateServiceRoles(Object.fromEntries(officialRoles.filter(role => defaults[mapping[role]]).map(role => [role, defaults[mapping[role]]])), routes);
}
export const serviceConfigurationSchema = z.object({
  version: z.literal(1), revision: z.uuid(), userId: z.string().min(1).max(200), origin: z.string().transform(normalizePlatformOrigin),
  auxiliaryEnabled: z.boolean(), fallbackEnabled: z.boolean().default(false), roles: rolesSchema, routes: z.array(serviceRouteSchema).max(100), updatedAt: z.iso.datetime(),
}).strict();
export type ServiceConfiguration = z.infer<typeof serviceConfigurationSchema>;
export type ServiceCredential = { userId: string; origin: string; revision: string; apiKey: string };
const stores = new Map<string, SecureCredentialStore<ServiceCredential>>();

export function servicePaths() {
  const userId = process.env.CCAGENT_ACCOUNT_ID;
  const comparable = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (!userId || comparable(getCCAgentHome()) !== comparable(accountHome(getPlatformHome(), userId))) {
    throw new Error("请先登录并初始化当前账户。");
  }
  const directory = path.join(getCCAgentHome(), "platform");
  return { state: path.join(directory, "services.json"), key: path.join(directory, "service-key.json"), journal: path.join(directory, "service-calls.json") };
}

export function serviceCredentialStore() {
  const file = servicePaths().key;
  let store = stores.get(file);
  if (!store) { store = new SecureCredentialStore<ServiceCredential>(file); stores.set(file, store); }
  return store;
}

/** Synchronous capability checks used by existing permission/decision selectors. */
export function officialAuxiliaryEnabled(): boolean {
  if (!process.env.CCAGENT_ACCOUNT_ID) return false;
  try {
    const file = servicePaths().state, info = lstatSync(file);
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error("invalid");
    const value = serviceConfigurationSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    if (value.userId !== process.env.CCAGENT_ACCOUNT_ID) throw new Error("owner");
    return value.auxiliaryEnabled;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("官方辅助服务配置无效，请重新验证平台 Key。");
  }
}

export async function readServiceConfiguration(): Promise<ServiceConfiguration | null> {
  const { state } = servicePaths();
  const info = await lstat(state).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (!info) return null;
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error("官方服务配置无效，请重新验证平台 Key。");
  try {
    const value = serviceConfigurationSchema.parse(JSON.parse(await readFile(state, "utf8")));
    if (value.userId !== process.env.CCAGENT_ACCOUNT_ID) throw new Error("owner");
    return value;
  } catch { throw new Error("官方服务配置无效，请重新验证平台 Key。"); }
}

export async function readServiceBinding(): Promise<{ configuration: ServiceConfiguration; credential: ServiceCredential } | null> {
  const configuration = await readServiceConfiguration();
  if (!configuration) return null;
  const credential = await serviceCredentialStore().read();
  if (!credential) return null;
  if (credential.userId !== configuration.userId || credential.origin !== configuration.origin || credential.revision !== configuration.revision || !platformKeyPattern.test(credential.apiKey)) {
    throw new Error("官方服务配置不完整，请重新验证平台 Key。");
  }
  return { configuration, credential };
}

export function validateServiceRoles(roles: unknown, routes: OfficialServiceRoute[]): ServiceRoles {
  const result = rolesSchema.parse(roles);
  const services = { main: "chat", image: "vision", decision: "decision", search: "search", voice: "voice" } as const;
  for (const role of officialRoles) {
    if (result[role] && !routes.some(route => route.id === result[role] && route.service === services[role])) throw new Error("选择的官方服务已不可用，请刷新服务目录。");
  }
  return result;
}
