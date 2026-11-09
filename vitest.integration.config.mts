// Integration tests: the real DuckDB engine, real files, and PostgreSQL when SV_PG_URL or podman is available.
import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
  test: { include: ['tests/integration/**/*.test.ts'], globalSetup: 'tests/tmp-root.ts', environment: 'node', testTimeout: 120_000, hookTimeout: 180_000, fileParallelism: false }
})
