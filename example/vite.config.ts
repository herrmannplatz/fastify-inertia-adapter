import inertia from '@inertiajs/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  root: import.meta.dirname,
  // SSR is rendered in-process by fastify-inertia-adapter/vite, not by Inertia's standalone SSR server.
  plugins: [inertia({ ssr: false }), vue()],
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    manifest: true,
    rollupOptions: { input: 'client/app.ts' },
  },
})
