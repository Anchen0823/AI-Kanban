import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 开发模式下 Vite 跑在 5173，API 跑在 8787。
 *
 * 用代理而不是让前端直接请求 http://127.0.0.1:8787，理由是 Cookie 与 Origin：
 * 同源请求才不会出现「Cookie 存了但跨站不带上」这类只在开发时才有的怪问题，
 * 也让开发环境的 CSRF / Origin 校验规则与生产保持一致。
 */
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
