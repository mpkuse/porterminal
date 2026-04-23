import { defineConfig, Plugin } from 'vite';
import { resolve } from 'path';
import { readdirSync, unlinkSync, existsSync } from 'fs';

/** Clean stale app-*.js and app-*.css after a successful build. */
function cleanStaleAssets(): Plugin {
  const assetsDir = resolve(__dirname, '../porterminal/static/assets');
  return {
    name: 'clean-stale-assets',
    writeBundle(_options, bundle) {
      if (!existsSync(assetsDir)) return;
      const emitted = new Set(
        Object.values(bundle)
          .map(asset => asset.fileName)
          .filter(fileName => fileName.startsWith('assets/app-'))
          .map(fileName => fileName.replace(/^assets\//, '')),
      );

      for (const file of readdirSync(assetsDir)) {
        const isAppAsset = file.startsWith('app-') && (file.endsWith('.js') || file.endsWith('.css'));
        if (isAppAsset && !emitted.has(file)) {
          unlinkSync(resolve(assetsDir, file));
        }
      }
    },
  };
}

export default defineConfig({
  root: '.',
  base: '/static/',
  plugins: [cleanStaleAssets()],

  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },

  build: {
    outDir: '../porterminal/static',
    emptyOutDir: false, // Preserve icons
    rollupOptions: {
      input: {
        app: resolve(__dirname, 'index.html'),
      },
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
    manifest: true,
  },

  server: {
    port: 5173,
    proxy: {
      '/ws': {
        target: 'ws://localhost:8000',
        ws: true,
      },
      '/api': {
        target: 'http://localhost:8000',
      },
    },
  },
});
