export type SignedUpdate = {
  payload: { schemaVersion: 1; keyId: string; version: string; platform: 'win32-x64'; channel: 'stable'; issuedAt: string; expiresAt: string;
    artifact: { url: string; size: number; sha256: string; signerCertificateSha256: string } };
  signature: string;
};
export function canonical(value: unknown): string;
export function compareVersions(a: string, b: string): number;
export function verifyManifest(envelope: unknown, trustedKeys: Record<string, string>, now?: number): SignedUpdate['payload'];
