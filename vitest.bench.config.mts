// Benchmarks (npm run bench): like the unit tests, but only tests/perf.
import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
  test: { include: ['tests/perf/**/*.test.ts'], globalSetup: 'tests/tmp-root.ts', environment: 'node', testTimeout: 300_000, reporters: ['verbose'], silent: false, fileParallelism: false }
})
