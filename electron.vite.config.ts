import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

const alias = { '@': resolve(__dirname, 'src') }

// Strict CSP for the packaged renderer (file:// pages get no response headers, so it is a meta tag).
// Not applied in dev, where Vite injects an inline HMR preamble. Inline styles: Radix positions popovers with them.
// No 'unsafe-eval' and no network: data never leaves the machine from the page.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'"
].join('; ')
const csp = { name: 'csp', apply: 'build' as const, transformIndexHtml: (html: string) => html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`) }

export default defineConfig({
  main: {
    resolve: { alias },
    // The engine runs in its own utility process: a second entry next to the main process.
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts'), engine: resolve(__dirname, 'src/engine/index.ts') } } }
  },
  preload: { resolve: { alias } },
  renderer: {
    resolve: { alias },
    plugins: [react(), tailwindcss(), csp],
    worker: { format: 'es' },
    build: { chunkSizeWarningLimit: 4000 }
  }
})
