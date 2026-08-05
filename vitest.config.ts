import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/renderer/src/lib/__tests__/**/*.test.ts', 'src/main/__tests__/**/*.test.ts'],
    globals: false,
    coverage: {
      provider: 'v8',
      include: ['src/main/**', 'src/renderer/src/lib/**'],
      exclude: ['**/__tests__/**'],
      reporter: ['text', 'json-summary'],
      /**
       * M2.6 coverage gate. Set below the measured numbers so an unrelated PR cannot trip
       * it on rounding, and meant to be ratcheted upward as coverage lands — never lowered
       * to make a red build pass.
       *
       * Measured 2026-08-05, after M2.3: statements 68.07, branches 63.07,
       * functions 68.51, lines 71.19.
       */
      thresholds: {
        statements: 65,
        branches: 60,
        functions: 65,
        lines: 68
      }
    }
  }
})
