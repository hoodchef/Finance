import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import path from 'node:path';

export default defineConfig(({ mode }) => ({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20_000,
    // Load .env / .env.local the way Next.js does. Without this, provider keys
    // are invisible to the runner and the live contract tests skip themselves —
    // a verification command that silently verifies nothing and reports green.
    env: loadEnv(mode, process.cwd(), ''),
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
}));
