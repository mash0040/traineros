/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Same-origin in dev, matching production where one App Service serves both. The session
    // cookie is first-party either way, which is what makes credentials: 'same-origin' work.
    proxy: {
      '/api': 'http://localhost:5216',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // The suite runs in UTC regardless of the machine it runs on. Without this, a test that a
    // date is resolved against users.timezone rather than the browser's zone passes for free on
    // a developer sitting in that timezone — which is exactly what happened when this was
    // mutation-checked from Toronto. Pinning it makes the machine stop being an input.
    env: { TZ: 'UTC' },
  },
})
