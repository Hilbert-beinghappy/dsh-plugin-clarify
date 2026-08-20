import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['**/._*', '**/node_modules/**'],
    environment: 'node',
  },
})
