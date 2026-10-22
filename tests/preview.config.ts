import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

// Renderer-only preview for UI checks. Tests provide the Electron API at page startup.
export default defineConfig({
  root: resolve(import.meta.dirname, '../src/renderer'),
  define: { __APP_VERSION__: JSON.stringify('test') },
  resolve: { alias: { '@renderer': resolve(import.meta.dirname, '../src/renderer/src') } },
  plugins: [
    vue({ template: { compilerOptions: { isCustomElement: (tag) => tag === 'webview' } } }),
    tailwindcss()
  ],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, watch: { usePolling: true } }
})
