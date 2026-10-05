import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // Relative base for GitHub Pages and arbitrary hosting subpaths
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    open: false,
  },
});
