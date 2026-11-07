import { checkServerIdentity, getCACertificates } from 'node:tls';
import { supabaseRootCA } from './supabase-root-ca';

const authorities = [...new Set([...getCACertificates('default'), ...getCACertificates('system'), supabaseRootCA])];

/** postgres@4.1 transport settings: keep parallel connections, avoid pooler pipelining. */
export function databaseOptions(max: number) {
  return { prepare: false, max, max_pipeline: 1, idle_timeout: 20, connect_timeout: 15,
    query_timeout: 30, queue_timeout: 15,
    ssl: { rejectUnauthorized: true, ca: authorities, checkServerIdentity }, onnotice: () => {} };
}
