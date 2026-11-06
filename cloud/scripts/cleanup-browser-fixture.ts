import './load-env';
import postgres from 'postgres';
import { databaseUrl } from '../src/core/env';

const schema = process.argv[2];
if (!schema || !/^ccagent_test_[a-f0-9]{16}$/.test(schema)) throw new Error('REFUSE_UNSCOPED_CLEANUP');
const owner = postgres(databaseUrl(true), { prepare: false, max: 1, ssl: 'require', onnotice: () => {} });
try {
  const users = await owner.unsafe<{ email: string }[]>(`select email from "${schema}"."user"`);
  if (users.length > 2 || users.some(user => !['ui-user@ccagent.example.invalid', 'ui-admin@ccagent.example.invalid'].includes(user.email))) throw new Error('REFUSE_NON_FIXTURE_DATA');
  await owner.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
  console.log(JSON.stringify({ cleaned: true, schema }));
} catch (error) {
  console.error(error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'FIXTURE_CLEANUP_FAILED');
  process.exitCode = 1;
} finally { await owner.end({ timeout: 5 }); }
