import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022', sourcemap: false,
    // One file for all the icons instead of one per icon: Discover alone pulled in ~20 tiny icon files, each a request that
    // queued behind the others on a slow phone connection.
    rolldownOptions: { output: { codeSplitting: { groups: [{ name: 'icons', test: /node_modules[\\/]lucide-react/ }] } } },
  },
  test: { include: ['tests/**/*.test.ts'], hookTimeout: 60_000 },
})
