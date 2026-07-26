import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  // Read env from the repo root so VITE_OIDC_ISSUER and VITE_OIDC_CLIENT_ID
  // come from the same .env the Bun server uses (only VITE_-prefixed vars
  // reach the client).
  envDir: '..',
  server: {
    proxy: {
      '/api': 'http://localhost:8000',
      '/screen/ws': { target: 'ws://localhost:8000', ws: true },
      '/julianscreen': 'http://localhost:8000',
      '/sprites': 'http://localhost:8000',
      '/sfx': 'http://localhost:8000',
    },
  },
});
