import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { formatPaymentMoney, paymentMoneyToMicro } from "./money.js";

export type ZpayParameters = Readonly<Record<string, string | number | null | undefined>>;

export interface ZpayOrder {
  merchantOrder: string;
  amountMicro: bigint;
  tradeNo?: string;
}

export interface VerifiedPayment {
  merchantOrder: string;
  tradeNo: string;
  amountMicro: bigint;
  channel: "alipay";
}

export class ZpayError extends Error {
  constructor(message: string, readonly code: string) { super(message); this.name = "ZpayError"; }
}

function secret(value: string): void {
  if (!value.trim() || /[\r\n\0]/.test(value)) throw new ZpayError("支付商户密钥未正确配置。", "configuration");
}

/** Compute over decoded values. The wire form is encoded only AFTER signing. */
export function signZpay(parameters: ZpayParameters, key: string): string {
  secret(key);
  const canonical = Object.keys(parameters).filter(name =>
    name !== "sign" && name !== "sign_type" && parameters[name] !== "" && parameters[name] !== null && parameters[name] !== undefined,
  ).sort().map(name => `${name}=${parameters[name]}`).join("&");
  return createHash("md5").update(canonical + key, "utf8").digest("hex");
}

export function verifyZpaySignature(parameters: ZpayParameters, key: string): boolean {
  const supplied = parameters.sign;
  if (parameters.sign_type !== "MD5" || typeof supplied !== "string" || !/^[a-f0-9]{32}$/.test(supplied)) return false;
  const expected = signZpay(parameters, key);
  return timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(expected, "hex"));
}

export function parseZpayNotification(search: URLSearchParams): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of search) {
    if (Object.hasOwn(result, name)) throw new ZpayError("支付通知包含重复参数。", "invalid_notification");
    if (name.length > 128 || value.length > 4096 || Object.keys(result).length >= 40) throw new ZpayError("支付通知格式错误。", "invalid_notification");
    result[name] = value;
  }
  return result;
}

function checkOrderNumber(order: string): void {
  if (!/^\d{1,32}$/.test(order)) throw new ZpayError("支付订单号格式错误。", "invalid_order");
}

export function createMerchantOrderNumber(): string {
  return Date.now().toString() + randomInt(0, 1_000_000_000).toString().padStart(9, "0");
}

function httpsOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ZpayError("支付网关地址格式错误。", "configuration"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new ZpayError("支付网关必须为不带路径、参数或账号的 HTTPS 地址。", "configuration");
  }
  return url.origin;
}

function callbackUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ZpayError("支付回调地址格式错误。", "configuration"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new ZpayError("支付回调必须使用不带查询参数的 HTTPS 地址。", "configuration");
  }
  return url.href;
}

export function verifyPaymentNotification(parameters: ZpayParameters, expected: ZpayOrder, merchantId: string, key: string): VerifiedPayment {
  if (!verifyZpaySignature(parameters, key)) throw new ZpayError("支付通知签名无效。", "invalid_signature");
  return matchPayment(parameters, expected, merchantId);
}

function matchPayment(parameters: ZpayParameters, expected: ZpayOrder, merchantId: string): VerifiedPayment {
  if (parameters.pid !== merchantId || parameters.out_trade_no !== expected.merchantOrder || parameters.type !== "alipay" || parameters.trade_status !== "TRADE_SUCCESS") {
    throw new ZpayError("支付通知与订单不符。", "order_mismatch");
  }
  let amount: bigint;
  try { amount = paymentMoneyToMicro(String(parameters.money)); } catch { throw new ZpayError("支付通知金额无效。", "order_mismatch"); }
  if (amount !== expected.amountMicro || amount <= 0n) throw new ZpayError("支付通知金额不符。", "order_mismatch");
  const tradeNo = parameters.trade_no;
  if (typeof tradeNo !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(tradeNo) || (expected.tradeNo && expected.tradeNo !== tradeNo)) {
    throw new ZpayError("支付平台交易号不符。", "order_mismatch");
  }
  return { merchantOrder: expected.merchantOrder, tradeNo, amountMicro: amount, channel: "alipay" };
}

type RefundResult = { status: "success" } | { status: "rejected" } | { status: "unknown" };

export interface ZpayClientOptions {
  merchantId: string;
  key: string;
  baseUrl?: string;
  channelId?: string;
  /** Injection seam for protocol tests; production uses the real network. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class ZpayClient {
  private readonly base: string;
  private readonly request: typeof fetch;
  constructor(private readonly options: ZpayClientOptions) {
    secret(options.key);
    if (!/^[A-Za-z0-9]{1,128}$/.test(options.merchantId)) throw new ZpayError("支付商户编号未正确配置。", "configuration");
    if (options.channelId && !/^\d+(?:,\d+)*$/.test(options.channelId)) throw new ZpayError("支付渠道编号格式错误。", "configuration");
    this.base = httpsOrigin(options.baseUrl ?? "https://zpayz.cn");
    this.request = options.fetch ?? fetch;
  }

  checkout(order: ZpayOrder, notifyUrl: string, returnUrl: string): { action: string; method: "POST"; fields: Record<string, string> } {
    checkOrderNumber(order.merchantOrder);
    const fields: Record<string, string> = {
      pid: this.options.merchantId, name: "CCAGENT API 服务余额充值", type: "alipay",
      money: formatPaymentMoney(order.amountMicro), out_trade_no: order.merchantOrder,
      notify_url: callbackUrl(notifyUrl), return_url: callbackUrl(returnUrl), sign_type: "MD5",
      ...(this.options.channelId ? { cid: this.options.channelId } : {}),
    };
    fields.sign = signZpay(fields, this.options.key);
    return { action: this.base + "/submit.php", method: "POST", fields };
  }

  private async json(url: URL, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const response = await this.request(url, { ...init, redirect: "error", signal: AbortSignal.timeout(this.options.timeoutMs ?? 8_000) });
    if (!response.ok) throw new ZpayError("支付平台请求暂未完成，请稍后核对。", "upstream_unavailable");
    const reader = response.body?.getReader();
    if (!reader) throw new ZpayError("支付平台返回格式错误。", "upstream_invalid");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > 65_536) { await reader.cancel(); throw new ZpayError("支付平台返回过大。", "upstream_invalid"); }
        chunks.push(item.value);
      }
      const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"), (_name, value: unknown, context?: { source?: string }) => {
        // Some channels return long merchant/transaction IDs as JSON integers.
        // Preserve their original digits instead of silently rounding through Number.
        if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) {
          if (!context?.source || !/^-?\d+$/.test(context.source)) throw new Error("unsafe integer");
          return context.source;
        }
        return value;
      });
      if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("shape");
      return result as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ZpayError) throw error;
      throw new ZpayError("支付平台返回格式错误，请核对订单。", "upstream_invalid");
    } finally { reader.releaseLock(); }
  }

  async queryPaidOrder(order: ZpayOrder): Promise<VerifiedPayment | null> {
    checkOrderNumber(order.merchantOrder);
    const url = new URL(this.base + "/api.php");
    url.search = new URLSearchParams({ act: "order", pid: this.options.merchantId, key: this.options.key, out_trade_no: order.merchantOrder }).toString();
    let result: Record<string, unknown>;
    try { result = await this.json(url); } catch { throw new ZpayError("支付查单暂未完成，请稍后重试。", "query_unconfirmed"); }
    if (result.code !== 1 && result.code !== "1") throw new ZpayError("支付查单尚未确认订单。", "query_unconfirmed");
    if (result.status === 0 || result.status === "0") return null;
    if (result.status !== 1 && result.status !== "1") throw new ZpayError("支付订单状态无法确认。", "query_unconfirmed");
    const payment: Record<string, string> = {
      pid: String(result.pid ?? ""), out_trade_no: String(result.out_trade_no ?? ""),
      trade_no: String(result.trade_no ?? ""), money: String(result.money ?? ""),
      type: String(result.type ?? ""), trade_status: "TRADE_SUCCESS",
    };
    // Query authenticates using the server-only merchant key over HTTPS; match its fields directly.
    return matchPayment(payment, order, this.options.merchantId);
  }

  /** Caller must freeze the original order amount and serialize refund attempts. No automatic retry. */
  async refund(order: ZpayOrder, amountMicro: bigint): Promise<RefundResult> {
    checkOrderNumber(order.merchantOrder);
    if (amountMicro !== order.amountMicro) throw new ZpayError("首版仅支持原订单全额退款。", "partial_refund_unsupported");
    const body = new URLSearchParams({ pid: this.options.merchantId, key: this.options.key,
      out_trade_no: order.merchantOrder, money: formatPaymentMoney(amountMicro) });
    try {
      const result = await this.json(new URL(this.base + "/api.php?act=refund"), {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
      });
      if (result.code === 1 || result.code === "1") return { status: "success" };
      if (typeof result.code === "number" || typeof result.code === "string") return { status: "rejected" };
      return { status: "unknown" };
    } catch { return { status: "unknown" }; }
  }
}
