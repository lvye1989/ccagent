import './load-env';
import { randomUUID } from 'node:crypto';
import { put, get, del } from '@vercel/blob';

const pathname = `ccagent/checks/${randomUUID()}.txt`, contents = 'CCAGENT private storage verification';
let success = false;
try {
  const file = await put(pathname, contents, { access: 'private', addRandomSuffix: false, contentType: 'text/plain', cacheControlMaxAge: 60, abortSignal: AbortSignal.timeout(15000) });
  const authenticated = await get(pathname, { access: 'private', useCache: false, abortSignal: AbortSignal.timeout(15000) });
  if (!authenticated || authenticated.statusCode !== 200 || await new Response(authenticated.stream).text() !== contents) throw new Error('PRIVATE_READ_FAILED');
  const anonymous = await fetch(file.url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  await anonymous.body?.cancel();
  if (![401, 403, 404].includes(anonymous.status)) throw new Error('PRIVATE_FILE_ACCESS_FAILED');
  success = true;
  console.log(JSON.stringify({ connected: true, privateRead: true, anonymousStatus: anonymous.status }));
} catch (error) {
  console.error(JSON.stringify({ connected: false, code: error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'BLOB_VERIFICATION_FAILED' }));
  process.exitCode = 1;
} finally {
  try { await del(pathname, { abortSignal: AbortSignal.timeout(15000) }); console.log(JSON.stringify({ temporaryFileCleaned: true, verified: success })); }
  catch { console.error('BLOB_TEMPORARY_CLEANUP_PENDING'); process.exitCode = 1; }
}
