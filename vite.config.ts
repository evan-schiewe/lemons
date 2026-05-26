import { visualizer } from 'rollup-plugin-visualizer';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/lemons/',
  build: {
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/echarts')) {
            return 'vendor-echarts';
          }

          if (
            id.includes('/src/features/charts/') ||
            id.includes('/src/features/dashboard/summaryCards.ts')
          ) {
            return 'feature-charts';
          }

          if (id.includes('node_modules/sql.js')) {
            return 'sqlite';
          }
        },
      },
    },
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  plugins: [
    visualizer({
      open: false, // Automatically opens the report in your browser after building
      filename: '.bundle-analysis.html', // The name of the file it generates
      gzipSize: true, // Shows you the gzipped sizes
      brotliSize: true, // Shows you the brotli sizes
    }),
  ],
});
