import assert from "node:assert/strict";
import {
  calculateCharge, formatMicroYuan, formatPaymentMoney, MAX_MONEY,
  parseRechargeMoney, paymentMoneyToMicro,
} from "../platform/money.js";
import {
  createMerchantOrderNumber, parseZpayNotification, signZpay, verifyPaymentNotification,
  verifyZpaySignature, ZpayClient, ZpayError,
} from "../platform/zpay.js";

let passed = 0;
function test(name: string, run: () => void): void { run(); passed++; console.log(`PASS ${name}`); }
async function asyncTest(name: string, run: () => Promise<void>): Promise<void> { await run(); passed++; console.log(`PASS ${name}`); }

test("recharge parsing is exact and uses integer fen", () => {
  assert.equal(parseRechargeMoney("0.01"), 10_000n);
  assert.equal(parseRechargeMoney("12345678.91"), 12_345_678_910_000n);
  assert.equal(formatPaymentMoney(parseRechargeMoney("1")), "1.00");
  assert.equal(paymentMoneyToMicro("0"), 0n);
  assert.equal(formatMicroYuan(-1n), "-0.000001");
  assert.equal(formatMicroYuan(MAX_MONEY), "9223372036854.775807");
  for (const input of ["0", "-1", "1e2", "01.00", "1.001", "NaN", " 1", "9223372036855"]) assert.throws(() => parseRechargeMoney(input));
  assert.throws(() => formatPaymentMoney(1n));
});

test("public USD price × measured usage × FX × 1.3 is exact", () => {
  const quote = calculateCharge([
    { quantity: "1000", publicPrice: "2.50", unitQuantity: "1000000", currency: "USD" },
    { quantity: "500", publicPrice: "10", unitQuantity: "1000000", currency: "USD" },
    { quantity: "1000", publicPrice: "0.25", unitQuantity: "1000000", currency: "USD" },
  ], "1.3", "7.2");
  assert.deepEqual(quote, { publicCostMicro: 55_800n, chargeMicro: 72_540n, markup: "1.3", usdCny: "7.2" });
});

test("fractional micro-yuan costs are added before final rounding", () => {
  const component = { quantity: 1n, publicPrice: "0.0000001", unitQuantity: 1n, currency: "CNY" as const };
  assert.equal(calculateCharge([component, component, component]).chargeMicro, 1n);
  assert.equal(calculateCharge(Array.from({ length: 10 }, () => component)).publicCostMicro, 1n);
  assert.equal(calculateCharge(Array.from({ length: 10 }, () => component)).chargeMicro, 2n);
});

test("missing FX and invalid measurements/prices fail closed", () => {
  const component = { quantity: "1", publicPrice: "1", unitQuantity: "1", currency: "USD" as const };
  assert.throws(() => calculateCharge([component]), /汇率/);
  assert.throws(() => calculateCharge([]), /公开成本/);
  assert.throws(() => calculateCharge([component], "1.3", "0"));
  assert.throws(() => calculateCharge([{ ...component, quantity: "-1" }], "1.3", "7"));
  assert.throws(() => calculateCharge([{ ...component, unitQuantity: "0" }], "1.3", "7"));
  assert.throws(() => calculateCharge([{ ...component, publicPrice: "Infinity" }], "1.3", "7"));
  assert.throws(() => calculateCharge([{ ...component, quantity: MAX_MONEY }], "1.3", "7"));
});

const key = "test-key";
const merchantId = "merchant";
const order = { merchantOrder: "20261106000000001", amountMicro: 1_000_000n };
const notice = {
  pid: merchantId, out_trade_no: order.merchantOrder, trade_no: "gateway123", money: "1.00",
  type: "alipay", trade_status: "TRADE_SUCCESS", sign_type: "MD5", sign: "",
};
notice.sign = signZpay(notice, key);

test("MD5 matches independent Python hashlib vector with Chinese and unencoded values", () => {
  const parameters = { pid: merchantId, name: "中文 空格", money: "1.00", param: "a&b=1", a: 0, empty: "", absent: null, sign_type: "MD5", sign: "ignored" };
  assert.equal(signZpay(parameters, key), "36d0cd9bb2e15e480f769ffa52ae1a71");
  assert.notEqual(signZpay({ ...parameters, a: "" }, key), signZpay(parameters, key));
});

test("notifications decode exactly once and reject duplicate names", () => {
  const fields = parseZpayNotification(new URLSearchParams("name=%E4%B8%AD%E6%96%87%20%2526&param=a%26b%3D1"));
  assert.equal(fields.name, "中文 %26");
  assert.equal(fields.param, "a&b=1");
  assert.throws(() => parseZpayNotification(new URLSearchParams("money=1&money=100")));
});

test("valid signed payment matches the server order", () => {
  assert.equal(verifyZpaySignature(notice, key), true);
  assert.deepEqual(verifyPaymentNotification(notice, order, merchantId, key), {
    merchantOrder: order.merchantOrder, tradeNo: "gateway123", amountMicro: 1_000_000n, channel: "alipay",
  });
});

test("forged or mismatched notifications never verify", () => {
  assert.equal(verifyZpaySignature({ ...notice, money: "100.00" }, key), false);
  assert.equal(verifyZpaySignature({ ...notice, sign: "a" }, key), false);
  assert.equal(verifyZpaySignature({ ...notice, sign_type: "RSA2" }, key), false);
  for (const change of [{ pid: "other" }, { money: "100" }, { out_trade_no: "111" }, { type: "wxpay" }, { trade_status: "WAIT_BUYER_PAY" }, { trade_no: "" }]) {
    const changed = { ...notice, ...change };
    changed.sign = signZpay(changed, key);
    assert.throws(() => verifyPaymentNotification(changed, order, merchantId, key));
  }
  assert.throws(() => verifyPaymentNotification(notice, { ...order, tradeNo: "other" }, merchantId, key));
});

test("checkout uses signed POST fields with no merchant key", () => {
  const client = new ZpayClient({ merchantId, key });
  const checkout = client.checkout(order, "https://ccagent.example/api/payment/notify", "https://ccagent.example/payment/result");
  assert.equal(checkout.action, "https://zpayz.cn/submit.php");
  assert.equal(checkout.method, "POST");
  assert.equal(checkout.fields.money, "1.00");
  assert.equal(verifyZpaySignature(checkout.fields, key), true);
  assert.equal(JSON.stringify(checkout).includes(key), false);
  assert.throws(() => client.checkout(order, "https://ccagent.example/notify?user=1", "https://ccagent.example/return"));
  assert.throws(() => new ZpayClient({ merchantId, key, baseUrl: "http://example.com" }));
  assert.match(createMerchantOrderNumber(), /^\d{1,32}$/);
});

await asyncTest("query confirms identity, amount, channel and transaction before declaring paid", async () => {
  const queryResponse: Record<string, unknown> = { code: 1, status: 1, pid: merchantId,
    out_trade_no: order.merchantOrder, money: "1.00", type: "alipay", trade_no: "gateway123" };
  let calls = 0;
  const request: typeof fetch = async (input, init) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.origin, "https://zpayz.cn");
    assert.equal(url.searchParams.get("act"), "order");
    assert.equal(url.searchParams.get("key"), key);
    assert.equal(init?.redirect, "error");
    return Response.json(queryResponse);
  };
  const client = new ZpayClient({ merchantId, key, fetch: request });
  assert.equal((await client.queryPaidOrder(order))?.tradeNo, "gateway123");
  queryResponse.money = "100.00";
  await assert.rejects(() => client.queryPaidOrder(order), ZpayError);
  queryResponse.money = "1.00";
  queryResponse.status = 0;
  assert.equal(await client.queryPaidOrder(order), null);
  queryResponse.status = "unexpected";
  await assert.rejects(() => client.queryPaidOrder(order));
  assert.equal(calls, 4);
});

await asyncTest("query errors contain neither provider URL nor merchant key", async () => {
  const client = new ZpayClient({ merchantId, key, fetch: async () => { throw new Error(`https://zpayz.cn/api.php?key=${key}`); } });
  try { await client.queryPaidOrder(order); assert.fail("Expected error"); } catch (error) {
    assert.equal(String(error).includes(key), false);
    assert.equal(String(error).includes("api.php"), false);
  }
});

await asyncTest("long numeric gateway identifiers retain every digit", async () => {
  const longMerchant = "201901151314084206659771";
  const longTrade = "2019011922001418111011411195";
  const client = new ZpayClient({ merchantId: longMerchant, key, fetch: async () => new Response(
    `{"code":1,"status":1,"pid":${longMerchant},"trade_no":${longTrade},"out_trade_no":"${order.merchantOrder}","money":"1.00","type":"alipay"}`,
    { headers: { "content-type": "application/json" } },
  ) });
  assert.equal((await client.queryPaidOrder(order))?.tradeNo, longTrade);
});

await asyncTest("refund posts full original amount once and rejects partial refunds", async () => {
  let calls = 0;
  const client = new ZpayClient({ merchantId, key, fetch: async (input, init) => {
    calls++;
    assert.equal(String(input), "https://zpayz.cn/api.php?act=refund");
    assert.equal(init?.method, "POST");
    const fields = new URLSearchParams(String(init?.body));
    assert.equal(fields.get("money"), "1.00");
    assert.equal(fields.get("key"), key);
    return Response.json({ code: 1, msg: "ok" });
  } });
  assert.deepEqual(await client.refund(order, order.amountMicro), { status: "success" });
  await assert.rejects(() => client.refund(order, 500_000n));
  assert.equal(calls, 1);
});

await asyncTest("ambiguous refund results stay unknown and are not retried", async () => {
  let calls = 0;
  const client = new ZpayClient({ merchantId, key, fetch: async () => { calls++; throw new Error("timeout"); } });
  assert.deepEqual(await client.refund(order, order.amountMicro), { status: "unknown" });
  assert.equal(calls, 1);
  const rejected = new ZpayClient({ merchantId, key, fetch: async () => Response.json({ code: "error" }) });
  assert.deepEqual(await rejected.refund(order, order.amountMicro), { status: "rejected" });
  const malformed = new ZpayClient({ merchantId, key, fetch: async () => new Response("not-json") });
  assert.deepEqual(await malformed.refund(order, order.amountMicro), { status: "unknown" });
});

console.log(`\n${passed} platform finance/payment checks passed. These are offline protocol checks, not live payment acceptance.`);
