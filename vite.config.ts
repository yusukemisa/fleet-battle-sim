import { defineConfig } from 'vitest/config'

export default defineConfig(({ command }) => ({
  // GitHub Pages serves the site under /fleet-battle-sim/. Dev stays at /.
  base: process.env.VITE_BASE ?? (command === 'build' ? '/fleet-battle-sim/' : '/'),
  server: { host: '0.0.0.0', port: 43173, strictPort: true },
  preview: { host: '0.0.0.0', port: 43173, strictPort: true },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
}))
