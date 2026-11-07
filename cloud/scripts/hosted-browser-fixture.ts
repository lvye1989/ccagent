import { isolatedDatabase } from '../tests/database-fixture';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { watch, existsSync } from 'node:fs';
import path from 'node:path';
import { hashPassword } from 'better-auth/crypto';

// Real, migrated test schema. The deployed application still uses its normal auth and runtime role.
const fixture = await isolatedDatabase();
const { database, closeDatabase } = await import('../src/core/db');
const tables = await import('../src/core/db/schema');
const output = path.resolve('..', 'output', 'playwright');
await mkdir(output, { recursive: true });
const stateFile = path.join(output, `hosted-fixture-${fixture.schema}.json`);
const stopFile = path.join(output, `${fixture.schema}.stop`);
let closing = false;
async function cleanup() {
  if (closing) return;
  closing = true;
  await closeDatabase();
  await fixture.cleanup();
  for (const file of [stateFile, stopFile]) {
    if (path.dirname(file) !== output || !path.basename(file).includes(fixture.schema)) throw new Error('REFUSE_UNSCOPED_FIXTURE_CLEANUP');
    await rm(file, { force: true });
  }
  console.log(JSON.stringify({ cleaned: true, isolatedSchema: fixture.schema, syntheticCredentialsRemoved: true }));
}
try {
  const password = randomBytes(32).toString('base64url'), hashed = await hashPassword(password);
  const users = [
    { id: randomUUID(), name: '线上验收用户', email: 'ui-user@ccagent.example.invalid' },
    { id: randomUUID(), name: '线上验收管理员', email: 'ui-admin@ccagent.example.invalid' },
  ];
  await database().db.insert(tables.user).values(users.map(user => ({ ...user, emailVerified: true })));
  await database().db.insert(tables.account).values(users.map(user => ({ id: randomUUID(), accountId: user.id, providerId: 'credential', userId: user.id, password: hashed })));
  await database().db.insert(tables.userRoles).values({ userId: users[1]!.id, roleId: 'admin' });
  if (process.argv.includes('--with-filter-data') || process.argv.includes('--with-operations-data')) {
    const { seedAdminFilterData } = await import('../tests/admin-filter-data');
    const data = await seedAdminFilterData(users);
    if (process.argv.includes('--with-operations-data')) {
      const { eq } = await import('drizzle-orm');
      await database().db.update(tables.reservations).set({ reconcileAt: new Date(Date.now() - 1000) }).where(eq(tables.reservations.id, data.callIds[6]!));
      await database().db.insert(tables.audit).values({ id: randomUUID(), action: 'system.maintenance', objectId: 'scheduled', result: 'partial', metadata: { fixtureOnly: true } });
    }
  }
  if (process.argv.includes('--with-default-data')) {
    const credentialEnv = 'CCAGENT_PROVIDER_DEFAULT_FIXTURE';
    process.env[credentialEnv] = 'synthetic-defaults-only-no-supplier-requests';
    const { saveRoute, createPriceVersion, routeInput, priceDefinition } = await import('../src/core/catalog');
    const rates = [
      { metric: 'input_tokens', price: '1', unitQuantity: '1000000' },
      { metric: 'cached_input_tokens', price: '0', unitQuantity: '1000000' },
      { metric: 'output_tokens', price: '1', unitQuantity: '1000000' },
    ];
    const examples = [
      { id: 'default-chat-a', name: '测试主模型 A', service: 'chat', protocol: 'openai-responses', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' },
      { id: 'default-chat-b', name: '测试主模型 B', service: 'chat', protocol: 'openai-responses', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' },
      { id: 'default-vision', name: '测试读图', service: 'vision', protocol: 'openai-chat', provider: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
      { id: 'default-decision', name: '测试决策', service: 'decision', protocol: 'jev-decisions', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1/decisions' },
      { id: 'default-search', name: '测试搜索', service: 'search', protocol: 'tavily', provider: 'tavily', baseUrl: 'https://api.tavily.com/search' },
      { id: 'default-voice', name: '测试语音', service: 'voice', protocol: 'dashscope-tts', provider: 'dashscope', baseUrl: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation' },
      { id: 'default-disabled', name: '测试未开放', service: 'chat', protocol: 'openai-responses', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' },
    ];
    for (const example of examples) {
      const route = routeInput.parse({ ...example, upstreamModel: 'synthetic-fixture-only', credentialEnv, options: {} });
      await saveRoute(users[1]!.id, route);
      if (example.id === 'default-disabled') continue;
      const definition = priceDefinition.parse({ rates: example.service === 'search' ? [{ metric: 'search_credits', price: '1', unitQuantity: '1' }]
        : example.service === 'voice' ? [{ metric: 'input_characters', price: '1', unitQuantity: '1000' }] : rates, tariff: { kind: 'constant' } });
      await createPriceVersion(users[1]!.id, { routeId: route.id, currency: 'CNY', definition, sourceUrl: 'https://example.invalid/synthetic-pricing', effectiveAt: new Date(Date.now() - 1000).toISOString() });
      await saveRoute(users[1]!.id, { ...route, enabled: true });
    }
  }
  await writeFile(stateFile, JSON.stringify({ schema: fixture.schema, password, users }), { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ ready: true, isolatedSchema: fixture.schema, stateFile: path.relative(path.resolve('..'), stateFile), stopFile: path.relative(path.resolve('..'), stopFile), realEmailsSent: false }));
  const stop = () => { void cleanup().then(() => process.exit(0), () => { console.error('HOSTED_FIXTURE_CLEANUP_FAILED'); process.exit(1); }); };
  const watcher = watch(output, (_event, name) => { if (name?.toString() === path.basename(stopFile) && existsSync(stopFile)) { watcher.close(); stop(); } });
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', data => { if (String(data).trim() === 'stop') { watcher.close(); stop(); } });
  process.stdin.resume();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  setTimeout(stop, 2700000);
} catch {
  console.error('HOSTED_FIXTURE_PREPARATION_FAILED');
  await cleanup();
  process.exitCode = 1;
}
