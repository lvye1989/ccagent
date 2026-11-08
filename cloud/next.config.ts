import type { NextConfig } from "next";
import path from 'node:path';

if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  serverExternalPackages: ["postgres"],
  turbopack: { root: path.resolve(import.meta.dirname, '..'), resolveAlias: { './money.js': '../src/platform/money.ts', zod: './node_modules/zod/index.js' } },
  outputFileTracingRoot: path.resolve(import.meta.dirname, '..'),
};

export default config;
