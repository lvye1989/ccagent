import { HttpError } from './http';

export type AdminSection = 'users' | 'roles' | 'permissions' | 'keys' | 'wallets' | 'orders' | 'refunds' | 'usage' | 'tasks' | 'ledger' | 'audit' | 'routes' | 'prices';
export const filterKeys = ['q', 'user', 'from', 'to', 'status', 'service', 'route', 'task', 'overdue'] as const;
export type AdminFilterKey = typeof filterKeys[number];
export type AdminFilterValues = Partial<Record<AdminFilterKey, string>>;
type Choice = readonly [string, string];
type Definition = { fields: readonly AdminFilterKey[]; statuses?: readonly Choice[]; placeholder: string };
const dates = ['from', 'to'] as const;
const callStatuses = [['held', '已授权'], ['pending', '待对账'], ['settled', '已结算'], ['released', '已释放']] as const;
export const serviceChoices: readonly Choice[] = [['chat', '主模型'], ['vision', '视觉读图'], ['decision', 'Jev 决策'], ['search', '搜索'], ['voice', '语音'], ['image', '图像生成']];
const definitions: Record<AdminSection, Definition> = {
  users: { fields: ['q', 'user', ...dates, 'status'], statuses: [['active', '正常'], ['disabled', '已禁用']], placeholder: '按邮箱搜索' },
  roles: { fields: ['q', ...dates], placeholder: '按角色名称搜索' },
  permissions: { fields: ['q'], placeholder: '按权限名称搜索' },
  keys: { fields: ['q', 'user', ...dates, 'status'], statuses: [['active', '可用'], ['revoked', '已撤销']], placeholder: '按 Key 名称搜索' },
  wallets: { fields: ['q', 'user', ...dates], placeholder: '按邮箱搜索' },
  orders: { fields: ['q', 'user', ...dates, 'status'], statuses: [['pending', '待支付 / 待核验'], ['credited', '已入账'], ['refunding', '退款中'], ['refunded', '已退款']], placeholder: '按订单编号搜索' },
  refunds: { fields: ['q', 'user', ...dates, 'status'], statuses: [['held', '已冻结'], ['submitting', '提交中'], ['pending', '待核对'], ['success', '退款成功'], ['rejected', '退款失败']], placeholder: '按原订单编号搜索' },
  usage: { fields: ['q', 'user', ...dates, 'status', 'service', 'route', 'task', 'overdue'], statuses: callStatuses, placeholder: '按任务编号搜索' },
  tasks: { fields: ['q', 'user', ...dates, 'status', 'service', 'route', 'task', 'overdue'], statuses: callStatuses, placeholder: '按任务编号搜索' },
  ledger: { fields: ['q', 'user', ...dates], placeholder: '按业务引用搜索' },
  audit: { fields: ['q', 'user', ...dates], placeholder: '按操作名称搜索' },
  routes: { fields: ['q', ...dates, 'status', 'service'], statuses: [['enabled', '已启用'], ['disabled', '已停用']], placeholder: '按服务名称搜索' },
  prices: { fields: ['q', ...dates, 'service', 'route'], placeholder: '按服务编号搜索' },
};
export function adminFilterDefinition(section: string): Definition {
  if (!Object.hasOwn(definitions, section)) throw new HttpError(404, 'NOT_FOUND', '页面不存在。');
  return definitions[section as AdminSection];
}
/** Only known fields are echoed into forms/links. React escapes all input values. */
export function adminFilterInputs(section: string, url: URL): AdminFilterValues {
  return Object.fromEntries(adminFilterDefinition(section).fields.map(key => [key, (url.searchParams.get(key) || '').trim().slice(0, key === 'user' ? 320 : 200)]));
}
export function parseAdminFilters(section: string, url: URL): AdminFilterValues {
  const definition = adminFilterDefinition(section);
  const allowed = new Set<string>([...filterKeys, 'page', 'pageSize', 'format', '_rsc']);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) throw new HttpError(400, 'INVALID_FILTER', '包含不支持的筛选参数，请清除后重新查询。');
    if (key !== '_rsc' && url.searchParams.getAll(key).length !== 1) throw new HttpError(400, 'DUPLICATE_FILTER', '筛选参数不能重复。');
  }
  const format = url.searchParams.get('format');
  if (format && !['csv', 'json'].includes(format)) throw new HttpError(400, 'INVALID_FORMAT', '导出格式无效。');
  const values: AdminFilterValues = {};
  for (const key of filterKeys) {
    const value = (url.searchParams.get(key) || '').trim();
    if (!value) continue;
    if (!definition.fields.includes(key)) throw new HttpError(400, 'UNSUPPORTED_FILTER', '此列表不支持提交的筛选条件。');
    const max = key === 'q' ? 120 : key === 'user' ? 320 : key === 'route' ? 80 : key === 'task' ? 200 : 30;
    if (value.length > max) throw new HttpError(400, 'FILTER_TOO_LONG', '筛选内容过长。');
    values[key] = value;
  }
  for (const key of dates) {
    const value = values[key];
    if (!value) continue;
    const date = new Date(`${value}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.toISOString().slice(0, 10) !== value) {
      throw new HttpError(400, 'INVALID_DATE', '请输入有效日期，格式为年-月-日。');
    }
  }
  if (values.from && values.to && values.from > values.to) throw new HttpError(400, 'INVALID_DATE_RANGE', '开始日期不能晚于结束日期。');
  if (values.status && !definition.statuses?.some(([value]) => value === values.status)) throw new HttpError(400, 'INVALID_STATUS', '请选择有效的状态。');
  if (values.service && !serviceChoices.some(([value]) => value === values.service)) throw new HttpError(400, 'INVALID_SERVICE', '请选择有效的服务类型。');
  if (values.overdue && values.overdue !== 'true') throw new HttpError(400, 'INVALID_OVERDUE_FILTER', '到期待处理筛选值无效。');
  return values;
}
