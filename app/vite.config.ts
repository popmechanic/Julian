import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  server: {
    proxy: {
      '/api': 'http://localhost:8000',
      '/screen/ws': { target: 'ws://localhost:8000', ws: true },
      '/sprites': 'http://localhost:8000',
    },
  },
});
