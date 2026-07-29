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
      reporter: ['text', 'json-summary']
    }
  }
})
