import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';
import {serveGemini} from './api/_node-adapter';

// В dev-режиме поднимаем тот же эндпоинт, что работает на проде,
// иначе AI-функции пришлось бы отлаживать только после деплоя.
const geminiDevEndpoint = {
  name: 'gemini-dev-endpoint',
  configureServer(server: any) {
    server.middlewares.use(async (req: any, res: any, next: any) => {
      const handled = await serveGemini(req, res).catch(() => false);
      if (!handled) next();
    });
  },
};

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), geminiDevEndpoint],
    // ВАЖНО: GEMINI_API_KEY сюда не подставляется. Ключ живёт только в
    // окружении сервера — иначе он оказывается в бандле и утекает всем подряд.
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
