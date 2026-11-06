/** Integer micro-yuan accounting. Never convert a balance through Number. */
export const MICRO_YUAN = 1_000_000n;
export const MICRO_FEN = 10_000n;
export const MAX_MONEY = 9_223_372_036_854_775_807n;

type Rational = { numerator: bigint; denominator: bigint };

function decimal(value: string, name: string): Rational {
  if (!/^(?:0|[1-9]\d{0,23})(?:\.\d{1,12})?$/.test(value)) {
    throw new Error(`${name} must be a nonnegative decimal with at most 12 fractional digits.`);
  }
  const [whole, fraction = ""] = value.split(".");
  return { numerator: BigInt(whole! + fraction), denominator: 10n ** BigInt(fraction.length) };
}

function integer(value: bigint | string, name: string, positive = false): bigint {
  if (typeof value === "string" && !/^(?:0|[1-9]\d{0,23})$/.test(value)) throw new Error(`${name} must be an integer.`);
  const result = typeof value === "bigint" ? value : BigInt(value);
  if (result < 0n || (positive && result === 0n) || result > MAX_MONEY) throw new Error(`${name} is out of range.`);
  return result;
}

function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a;
}

function add(a: Rational, b: Rational): Rational {
  const common = gcd(a.denominator, b.denominator);
  const numerator = a.numerator * (b.denominator / common) + b.numerator * (a.denominator / common);
  const denominator = a.denominator * (b.denominator / common);
  const reduce = gcd(numerator, denominator);
  return { numerator: numerator / reduce, denominator: denominator / reduce };
}

function roundUpMoney(value: Rational): bigint {
  const amount = (value.numerator + value.denominator - 1n) / value.denominator;
  if (amount < 0n || amount > MAX_MONEY) throw new Error("Money is out of range.");
  return amount;
}

/** Parse payment-provider yuan (at most two decimals) without floating point. */
export function paymentMoneyToMicro(value: string): bigint {
  if (!/^(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/.test(value)) throw new Error("支付金额格式错误，最多保留两位小数。");
  const [whole, fraction = ""] = value.split(".");
  const result = BigInt(whole!) * MICRO_YUAN + BigInt(fraction.padEnd(2, "0")) * MICRO_FEN;
  if (result > MAX_MONEY) throw new Error("支付金额超出范围。");
  return result;
}

export function parseRechargeMoney(value: string): bigint {
  const amount = paymentMoneyToMicro(value);
  if (amount < MICRO_FEN) throw new Error("充值金额至少为 0.01 元。");
  return amount;
}

export function formatPaymentMoney(amount: bigint): string {
  if (amount < MICRO_FEN || amount > MAX_MONEY || amount % MICRO_FEN !== 0n) throw new Error("支付金额必须为正整数分。");
  return `${amount / MICRO_YUAN}.${((amount % MICRO_YUAN) / MICRO_FEN).toString().padStart(2, "0")}`;
}

/** Exact display; supports signed ledger movements. */
export function formatMicroYuan(amount: bigint): string {
  if (amount < -MAX_MONEY || amount > MAX_MONEY) throw new Error("Money is out of range.");
  const sign = amount < 0n ? "-" : "";
  const absolute = amount < 0n ? -amount : amount;
  return `${sign}${absolute / MICRO_YUAN}.${(absolute % MICRO_YUAN).toString().padStart(6, "0")}`;
}

export interface CostComponent {
  quantity: bigint | string;
  /** Public price per unitQuantity, e.g. 2.50 USD per 1,000,000 tokens. */
  publicPrice: string;
  unitQuantity: bigint | string;
  currency: "CNY" | "USD";
}

export interface ChargeQuote {
  publicCostMicro: bigint;
  chargeMicro: bigint;
  markup: string;
  usdCny: string | null;
}

/** Sum exact costs first, then round once. Cached tokens are separate components. */
export function calculateCharge(components: readonly CostComponent[], markup = "1.3", usdCny?: string): ChargeQuote {
  if (!components.length) throw new Error("服务尚未配置公开成本或无法核实用量。");
  const multiplier = decimal(markup, "Markup");
  if (!multiplier.numerator) throw new Error("Markup must be positive.");
  let total: Rational = { numerator: 0n, denominator: 1n };
  let usedUsd = false;
  for (const component of components) {
    const quantity = integer(component.quantity, "Quantity");
    const unit = integer(component.unitQuantity, "Unit quantity", true);
    const price = decimal(component.publicPrice, "Public price");
    let rate: Rational = { numerator: 1n, denominator: 1n };
    if (component.currency === "USD") {
      if (!usdCny) throw new Error("美元服务尚未配置结算汇率。");
      rate = decimal(usdCny, "USD/CNY rate");
      if (!rate.numerator) throw new Error("USD/CNY rate must be positive.");
      usedUsd = true;
    } else if (component.currency !== "CNY") {
      throw new Error("Unsupported currency.");
    }
    total = add(total, {
      numerator: quantity * price.numerator * rate.numerator * MICRO_YUAN,
      denominator: unit * price.denominator * rate.denominator,
    });
  }
  return {
    publicCostMicro: roundUpMoney(total),
    chargeMicro: roundUpMoney({ numerator: total.numerator * multiplier.numerator, denominator: total.denominator * multiplier.denominator }),
    markup,
    usdCny: usedUsd ? usdCny! : null,
  };
}
