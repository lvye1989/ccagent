/** Resolve credentials at transport startup; persisted configs keep environment references. */
export function resolveMcpEnvironment(values: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!values) return undefined;
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_match, name: string) => {
    const resolved = process.env[name];
    if (resolved === undefined) throw new Error(`MCP environment variable ${name} is not configured.`);
    return resolved;
  })]));
}
