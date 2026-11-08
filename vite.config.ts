import { defineConfig } from 'vitest/config'

export default defineConfig({
  server: { host: '0.0.0.0', port: 43173, strictPort: true },
  preview: { host: '0.0.0.0', port: 43173, strictPort: true },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
