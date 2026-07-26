import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  // Read env from the repo root so VITE_CLERK_PUBLISHABLE_KEY comes from the
  // same .env the Bun server uses (only VITE_-prefixed vars reach the client).
  envDir: '..',
  server: {
    proxy: {
      '/api': 'http://localhost:8000',
      '/screen/ws': { target: 'ws://localhost:8000', ws: true },
      '/sprites': 'http://localhost:8000',
      '/sfx': 'http://localhost:8000',
    },
  },
});
