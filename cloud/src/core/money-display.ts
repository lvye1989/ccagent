/** Human-facing yuan amounts. Internal storage and HTTP accounting remain integer micro-yuan. */
const MICRO_PER_YUAN = 1_000_000n;
const MAX_BIGINT = 9_223_372_036_854_775_807n;
type IntegerMoney = bigint | string | number;

function integer(value: IntegerMoney): bigint {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('金额超出精确显示范围。');
  if (typeof value === 'string' && !/^-?\d+$/.test(value)) throw new Error('金额格式无效。');
  return BigInt(value);
}
function decimal(value: bigint, scale: bigint, precision: number): string {
  const absolute = value < 0n ? -value : value;
  const fraction = (absolute % scale).toString().padStart(precision, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${value < 0n ? '-' : ''}${absolute / scale}.${fraction}`;
}
/** Exact, ungrouped yuan for UI, CSV and form values; preserves a single micro-yuan. */
export function formatMicroYuan(value: IntegerMoney): string { return decimal(integer(value), MICRO_PER_YUAN, 6); }
export function formatFenYuan(value: IntegerMoney): string { return decimal(integer(value), 100n, 2); }
/** Parses yuan without floating point. Negative amounts must be explicitly permitted. */
export function parseYuanToMicro(value: string, options: { allowNegative?: boolean; maxMicro?: bigint } = {}): string {
  const text = value.trim();
  if (!(options.allowNegative ? /^-?(?:0|[1-9]\d{0,18})(?:\.\d{1,6})?$/ : /^(?:0|[1-9]\d{0,18})(?:\.\d{1,6})?$/).test(text)) {
    throw new Error(`金额请输入${options.allowNegative ? '' : '非负'}人民币元，最多保留 6 位小数。`);
  }
  const negative = text.startsWith('-'), [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const absolute = BigInt(whole) * MICRO_PER_YUAN + BigInt(fraction.padEnd(6, '0'));
  if (absolute > (options.maxMicro ?? MAX_BIGINT)) throw new Error('金额超出允许范围。');
  return (negative ? -absolute : absolute).toString();
}

const microLabels: Record<string, string> = {
  limit: '累计额度（元）', spent: '已使用（元）', frozen: '冻结（元）', balance: '余额（元）', user_balance: '用户余额（元）',
  available: '可用余额（元）', amount: '金额（元）', authorized: '授权（元）', charged: '费用（元）',
  balance_delta: '余额变动（元）', frozen_delta: '冻结变动（元）', balance_after: '变动后余额（元）', frozen_after: '变动后冻结（元）',
};
export function moneyColumnLabel(key: string): string | undefined { return key === 'amount_fen' ? '充值金额（元）' : Object.hasOwn(microLabels, key) ? microLabels[key] : undefined; }
export function displayMoneyValue(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'bigint' && typeof value !== 'string' && typeof value !== 'number') return value;
  if (key === 'amount_fen') return formatFenYuan(value);
  return Object.hasOwn(microLabels, key) ? formatMicroYuan(value) : value;
}

const nestedMicroNames: Record<string, string> = {
  ...microLabels,
  balanceDelta: '余额变动（元）', frozenDelta: '冻结变动（元）', balanceAfter: '变动后余额（元）', frozenAfter: '变动后冻结（元）',
  publicCostMicro: '公开成本（元）', chargeMicro: '费用（元）', platformAbsorbedMicro: '平台承担费用（元）',
  estimatedPublicCostMicro: '预计公开成本（元）', authorizedMicro: '授权（元）', chargedMicro: '费用（元）', userChargeMicro: '用户扣费（元）',
  delta: '余额调整（元）', balanceBefore: '调整前余额（元）', targetBalance: '目标余额（元）',
  previousLimit: '原累计额度（元）',
};
/** Converts only known money fields; token counts, identifiers and supplier currency prices stay unchanged. */
export function presentMoneyDetails(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(presentMoneyDetails);
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const label = key === 'amountFen' || key === 'amount_fen' ? '充值金额（元）' : Object.hasOwn(nestedMicroNames, key) ? nestedMicroNames[key] : undefined;
    if (label && item !== null && (typeof item === 'bigint' || typeof item === 'string' || typeof item === 'number')) {
      try { return [label, key === 'amountFen' || key === 'amount_fen' ? formatFenYuan(item) : formatMicroYuan(item)]; } catch { /* Non-money metadata with the same field name remains unchanged. */ }
    }
    return [key, presentMoneyDetails(item)];
  }));
}
