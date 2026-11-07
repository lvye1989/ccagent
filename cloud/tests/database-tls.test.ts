import '../scripts/load-env';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import net from 'node:net';
import tls from 'node:tls';
import { databaseUrl } from '../src/core/env';
import { databaseOptions } from '../src/core/db/options';

/** PostgreSQL SSLRequest + TLS only. No startup packet, username or password. */
async function probe(options: { servername?: string; ca?: string[] } = {}): Promise<void> {
  const address = new URL(databaseUrl(true));
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host: address.hostname, port: Number(address.port || 5432) });
    let secure: tls.TLSSocket | undefined;
    const timer = setTimeout(() => finish(new Error('TLS_PROBE_TIMEOUT')), 15000);
    const finish = (error?: Error) => { clearTimeout(timer); secure?.destroy(); socket.destroy(); error ? reject(error) : resolve(); };
    socket.once('error', finish);
    socket.once('connect', () => { const request = Buffer.alloc(8); request.writeInt32BE(8, 0); request.writeInt32BE(80877103, 4); socket.write(request); });
    socket.once('data', value => {
      if (value[0] !== 83) return finish(new Error('DATABASE_SSL_REQUIRED'));
      secure = tls.connect({ socket, servername: address.hostname, ...databaseOptions(1).ssl, ...options });
      secure.once('error', finish); secure.once('secureConnect', () => finish());
    });
  });
}

test('database TLS verifies the vendor CA and hostname before any credentials', { timeout: 60000 }, async t => {
  await t.test('current Supabase chain verifies with the shared backend trust policy', () => probe());
  await t.test('an untrusted chain is rejected even if the parent disables default Node verification', async () => {
    const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED; process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try { await assert.rejects(() => probe({ ca: [] }), (error: NodeJS.ErrnoException) => ['SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(error.code ?? '')); }
    finally { if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous; }
  });
  await t.test('a valid chain with another hostname is rejected', async () => {
    await assert.rejects(() => probe({ servername: 'ccagent-hostname-mismatch.invalid' }), (error: NodeJS.ErrnoException) => error.code === 'ERR_TLS_CERT_ALTNAME_INVALID');
  });
  t.diagnostic('Live credential-free PostgreSQL TLS probes; no authentication packets, database writes or service calls.');
});
