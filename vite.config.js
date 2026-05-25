import { defineConfig } from 'vite';

export default defineConfig({
    base: '/lemons/',
    build: {
        rollupOptions: {
            output: {
                manualChunks(id) {
                    if (id.includes('node_modules/echarts')) {
                        return 'charts';
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
});