import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Dev proxies the API prefixes to a running instad; production is same-origin (instad serves dist).
const API_PREFIXES = ['/projects', '/orgs', '/me', '/tokens', '/healthz']
const target = process.env.VITE_INSTA_API ?? 'http://127.0.0.1:8080'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Explicit empty postcss config: stop Vite from crawling parent dirs for stray postcss configs.
  css: { postcss: { plugins: [] } },
  server: {
    proxy: Object.fromEntries(API_PREFIXES.map((p) => [p, { target, changeOrigin: true }])),
  },
})
