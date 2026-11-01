import { defineConfig } from 'vitest/config'

export default defineConfig({ test: { include: ['test/**/*.spec.ts'], exclude: ['cdk.out/**', 'node_modules/**'], testTimeout: 300_000 } })
