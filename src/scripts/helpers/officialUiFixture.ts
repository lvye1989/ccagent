import type { IncomingMessage, ServerResponse } from "node:http";
import type { AccountUser } from "../../platform/accountClient.js";

/** UI-only account/catalog data. Every paid endpoint is deliberately unavailable. */
export function officialUiHandler(fixtureKey: string, options: { fallback?: boolean; priceRevision?: () => number } = {}) {
  return async (req: IncomingMessage, res: ServerResponse, user: AccountUser | undefined): Promise<boolean> => {
    const reply = (status: number, data: unknown) => { res.writeHead(status); res.end(JSON.stringify(data)); return true; };
    if (!user) return reply(401, { code: "UNAUTHORIZED" });
    if (req.url === "/api/account/me") return reply(200, { user, permissions: user.id.endsWith("-a") ? ["admin.read"] : [] });
    if (req.url === "/api/account/wallet") return reply(200, { wallet: { available: "1000000", frozen: "50000" } });
    if (req.url === "/v1/models") {
      if (req.headers.authorization !== `Bearer ${fixtureKey}`) return reply(403, { code: "INVALID_KEY" });
      const definitions = [
        ["main", "主模型", "chat", "openai-responses"], ["vision", "读图", "vision", "openai-chat"],
        ["decision", "决策", "decision", "jev-decisions"], ["search", "搜索", "search", "tavily"], ["voice", "语音", "voice", "dashscope-tts"],
      ];
      if (options.fallback) definitions.push(['backup', '备用主模型', 'chat', 'openai-responses']);
      const revision = options.priceRevision?.() || 1;
      return reply(200, { ...(options.fallback ? { defaults: { chat: 'fixture-main', vision: 'fixture-vision', decision: 'fixture-decision', search: 'fixture-search', voice: 'fixture-voice' } } : {}),
        data: definitions.map(([id, name, service, protocol]) => ({ id: `fixture-${id}`, name: `界面测试 · ${name}`, service, protocol,
        pricing: { currency: "CNY", definition: { rates: [{ metric: "requests", price: id === 'backup' ? String(revision) : "1", unitQuantity: "1" }], tariff: { kind: "constant" } }, markup: "1.3", version: id === 'backup' ? revision : 1, usdCny: null, sourceUrl: "https://example.com/pricing",
          ...(options.fallback ? { fingerprint: (id === 'main' ? 'a' : id === 'backup' ? revision === 1 ? 'b' : 'c' : 'd').repeat(64) } : {}) },
        limits: { contextWindow: 131072, maxOutputTokens: 4096, maxImages: 20, fallbackRouteId: options.fallback && id === 'main' ? 'fixture-backup' : null, fallbackEnabled: options.fallback && id === 'main' },
      })) });
    }
    return reply(404, { code: "FIXTURE_NO_PAID_SERVICES" });
  };
}
