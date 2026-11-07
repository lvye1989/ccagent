import type postgres from 'postgres';

/** One grant policy for deployment and isolated recovery verification. */
export async function grantRuntimeAccess(owner: postgres.Sql, schema: string): Promise<void> {
  if (schema !== 'ccagent' && !/^ccagent_test_[a-f0-9]{16}$/.test(schema)) throw new Error('REFUSE_UNSCOPED_RUNTIME_GRANT');
  const namespace = `"${schema}"`, role = 'ccagent_runtime';
  await owner.unsafe(`GRANT USAGE ON SCHEMA ${namespace} TO ${role}`);
  await owner.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${namespace} TO ${role}`);
  await owner.unsafe(`REVOKE ALL ON ${namespace}.__drizzle_migrations FROM ${role}`);
  await owner.unsafe(`GRANT SELECT ON ${namespace}.__drizzle_migrations TO ${role}`);
  await owner.unsafe(`REVOKE INSERT, UPDATE, DELETE ON ${namespace}.wallets, ${namespace}.ledger FROM ${role}`);
  // A fresh deployment may create the role after applying migrations. Grants
  // inside those migrations would then have been skipped; repair every known
  // financial entrypoint without making functions executable by PUBLIC.
  for (const signature of ['post_ledger(text,text,text,bigint,bigint,jsonb)', 'authorize_usage(text,text,text,text,text,text,bigint,jsonb)', 'finish_usage(text,text,bigint,jsonb,boolean)', 'acquire_mutex(bigint)', 'lock_wallet(text)']) {
    const [present] = await owner`select to_regprocedure(${schema + '.' + signature}) is not null as present`;
    if (present!.present) await owner.unsafe(`GRANT EXECUTE ON FUNCTION ${namespace}.${signature} TO ${role}`);
  }
}
