import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

// Served by the SFU at /admin/ (src/http-server.ts → admin-ui/dist).
export default defineConfig({
  base: '/admin/',
  plugins: [preact()],
  // @nostr-wot/ui is written against React; run it on Preact.
  resolve: {
    alias: {
      react: 'preact/compat',
      'react-dom': 'preact/compat',
      'react-dom/client': 'preact/compat',
      'react/jsx-runtime': 'preact/jsx-runtime',
      'react/jsx-dev-runtime': 'preact/jsx-dev-runtime',
    },
  },
  server: {
    host: true,
    proxy: {
      '^/admin/(session|state|restart|sync-follows|test-peers?)': 'http://127.0.0.1:4848',
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
})
