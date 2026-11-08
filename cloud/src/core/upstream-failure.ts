export type UpstreamTransportFailure = 'timeout' | 'dns' | 'tls' | 'connection' | 'transport';

/** Fixed diagnostic labels only: never persist provider errors, URLs, headers or secrets. */
export function upstreamTransportFailure(error: unknown, aborted = false): UpstreamTransportFailure {
  if (aborted) return 'timeout';
  const visited = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !visited.has(current) && visited.size < 5) {
    visited.add(current);
    const code = (current as Error & { code?: unknown }).code;
    if (current.name === 'AbortError' || current.name === 'TimeoutError' || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(String(code))) return 'timeout';
    if (['ENOTFOUND', 'EAI_AGAIN'].includes(String(code))) return 'dns';
    if (['CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT'].includes(String(code))) return 'tls';
    if (['ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET'].includes(String(code))) return 'connection';
    current = current.cause;
  }
  return 'transport';
}
