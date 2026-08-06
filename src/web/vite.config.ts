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
    // Vitest forks a worker per test file, and each one builds its own jsdom — measured at
    // 4–6 seconds of CPU before a single assertion runs. At the default width (cores - 1)
    // that is a dozen jsdom builds competing for eight cores and 8 GB, and the starvation
    // lands on whatever is doing real work: userEvent.type dispatches a keystroke, waits a
    // macrotask, and gets scheduled late enough that a ~1.3s test trips the 5s timeout.
    // LoginScreen and ClientsScreen were failing that way, and both pass alone.
    //
    // Halving the width fixed it and made the suite faster: 98s with 2–3 spurious failures
    // at the default, 70s green at 50%. Faster because the environment cost is what was
    // being multiplied — total environment time fell from 356s to 129s.
    //
    // Not `isolate: false` (state leaks between files: 8 failures) and not `pool: 'threads'`
    // (18 failures) — both were measured, both were worse.
    maxWorkers: '50%',
  },
})
