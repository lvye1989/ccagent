import { HttpError } from './http';

export type UpstreamTransportFailure = 'timeout' | 'dns' | 'tls' | 'connection' | 'transport';

/** Preserve only a fixed category across the native transport boundary, never raw supplier errors. */
export class UpstreamTransportError extends HttpError {
  readonly transportFailure: UpstreamTransportFailure;
  constructor(error: unknown, aborted = false) {
    super(502, 'UPSTREAM_TRANSPORT_FAILED', '上游连接未完成。');
    this.transportFailure = upstreamTransportFailure(error, aborted);
  }
}

/** Fixed diagnostic labels only: never persist provider errors, URLs, headers or secrets. */
export function upstreamTransportFailure(error: unknown, aborted = false): UpstreamTransportFailure {
  if (aborted) return 'timeout';
  const visited = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !visited.has(current) && visited.size < 5) {
    visited.add(current);
    if (current instanceof UpstreamTransportError) return current.transportFailure;
    const code = (current as Error & { code?: unknown }).code;
    if (current.name === 'AbortError' || current.name === 'TimeoutError' || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(String(code))) return 'timeout';
    if (['ENOTFOUND', 'EAI_AGAIN'].includes(String(code))) return 'dns';
    if (['CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT'].includes(String(code))) return 'tls';
    if (['ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET'].includes(String(code))) return 'connection';
    current = current.cause;
  }
  return 'transport';
}
