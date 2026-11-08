import './load-env';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse } from 'dotenv';

const project = 'prj_2VwqV4ZbAkSX4WKJKDImBzWsNNYF', team = 'team_00cQVitR68vaaggGmAEYYrC5', scope = 'lvye-1989s-projects';
const cloudRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assert.equal(process.cwd().toLowerCase(), cloudRoot.toLowerCase(), 'RUN_FROM_CLOUD_DIRECTORY');
const linked = JSON.parse(await readFile(path.join(cloudRoot, '.vercel/project.json'), 'utf8'));
assert.equal(linked.projectId, project); assert.equal(linked.orgId, team);

function cli(args: string[], input?: string): Promise<string> {
  assert.ok(args.every(value => /^[A-Za-z0-9_:/?.=\-]+$/.test(value)), 'UNSAFE_PROVIDER_CONFIG_ARGUMENT');
  const environment: NodeJS.ProcessEnv = { ...process.env, NODE_USE_SYSTEM_CA: '1', NODE_USE_ENV_PROXY: '1' };
  delete environment.NODE_TLS_REJECT_UNAUTHORIZED;
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', ['npx.cmd', '--offline', '--yes', 'vercel@65.12.1', ...args].join(' ')],
      { cwd: cloudRoot, windowsHide: true, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', value => { output += String(value); });
    // Neither stream is logged: provider configuration responses may contain secret fields.
    child.stderr.resume();
    child.once('error', () => reject(new Error('PROVIDER_CONFIG_CLI_START_FAILED')));
    child.once('exit', code => code === 0 ? resolve(output) : reject(new Error('PROVIDER_CONFIG_CLI_FAILED')));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
type EnvironmentMetadata = { id: string; key: string; type: string; target: string[]; gitBranch?: string | null };
async function metadata() {
  const result = JSON.parse(await cli(['api', `/v9/projects/${project}`, '--scope', scope, '--raw']));
  assert.equal(result.id, project); assert.equal(result.accountId, team); assert.equal(result.name, 'ccagent-cloud');
  return (result.env || []) as EnvironmentMetadata[];
}

const credentialSources = [
  { service: 'deepseek', name: 'CCAGENT_PROVIDER_DEEPSEEK', sources: ['DEEPSEEK_API_KEY'] },
  { service: 'qwen', name: 'CCAGENT_PROVIDER_QWEN', sources: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY'] },
  { service: 'jev', name: 'CCAGENT_PROVIDER_JEV', sources: ['OPENROUTER_API_KEY'] },
  { service: 'tavily', name: 'CCAGENT_PROVIDER_TAVILY', sources: ['TAVILY_API_KEY', 'WEB_SEARCH_API_KEY'] },
  { service: 'bocha', name: 'CCAGENT_PROVIDER_BOCHA', sources: ['bocha_API_KEY', 'BOCHA_API_KEY'] },
];
const identity = JSON.parse(await cli(['whoami', '--format', 'json']));
assert.equal(identity.team.id, team); assert.equal(identity.cliVersion, '65.12.1');
const credentials = parse(await readFile(path.join(cloudRoot, '../.env')));
const before = await metadata();
const actions = credentialSources.map(item => {
  const source = item.sources.find(name => credentials[name]?.trim());
  assert.ok(source, `MISSING_${item.service.toUpperCase()}_CREDENTIAL`);
  assert.ok(!/[\r\n\0]/.test(credentials[source!]!), 'MULTILINE_PROVIDER_CREDENTIAL_REJECTED');
  const existing = before.filter(entry => entry.key === item.name && entry.target?.includes('preview'));
  assert.ok(existing.length <= 1 && !existing.some(entry => entry.gitBranch), 'REVIEW_BRANCH_SPECIFIC_PROVIDER_CONFIGURATION');
  if (existing.length) assert.equal(existing[0]!.type, 'sensitive', 'EXISTING_PROVIDER_VARIABLE_MUST_BE_SECRET');
  return { ...item, source: source!, action: existing.length ? 'preserve-existing-secret' : 'create-preview-secret' };
});
const report = { at: new Date().toISOString(), project, team, environment: 'preview', status: 'planned', changes: [] as { service: string; name: string; action: string; verified?: boolean }[],
  realProviderRequests: false, realMailSent: false, realPayments: false, databaseWrites: false, productionChanged: false, existingValuesReadBack: false };
const runMode = process.argv.includes('--run');
const output = path.resolve(cloudRoot, `../output/checks/${runMode ? 'provider-env-configuration' : 'provider-env-plan'}.json`);
const save = async () => { await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n'); };
if (!runMode) {
  report.changes = actions.map(({ service, name, action }) => ({ service, name, action }));
  await save(); console.log(JSON.stringify(report));
} else {
  report.status = 'running'; await save();
  try {
    for (const action of actions) {
      const entry = { service: action.service, name: action.name, action: action.action, verified: false };
      report.changes.push(entry); await save();
      if (action.action === 'create-preview-secret') {
        await cli(['env', 'add', action.name, '--environment', 'preview', '--type', 'secret', '--project', project, '--scope', scope, '--yes', '--json'], credentials[action.source]!.trim());
      }
      const records = await metadata();
      const matching = records.filter(value => value.key === action.name && value.target?.includes('preview'));
      assert.equal(matching.length, 1); assert.equal(matching[0]!.type, 'sensitive');
      assert.deepEqual(matching[0]!.target, ['preview']); assert.ok(!matching[0]!.gitBranch);
      for (const previous of before) {
        const current = records.find(value => value.id === previous.id);
        assert.ok(current, 'EXISTING_ENVIRONMENT_REMOVED');
        assert.equal(current.key, previous.key); assert.equal(current.type, previous.type);
        assert.deepEqual(current.target, previous.target); assert.equal(current.gitBranch, previous.gitBranch);
      }
      entry.verified = true; await save(); console.log(JSON.stringify(entry));
    }
    report.status = 'configured';
  } catch {
    report.status = 'failed'; process.exitCode = 1;
    console.error('PROVIDER_ENV_CONFIGURATION_FAILED');
  } finally { await save(); }
}
