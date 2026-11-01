import { defineConfig, loadEnv } from 'vite';

// Jev wird ueber den Dev-Server weitergeleitet (umgeht CORS, Key bleibt auf dem Server).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const key = env.VITE_JEV_API_KEY || env.JEV_API_KEY || '';
  const target = new URL(env.VITE_JEV_API_URL || env.JEV_API_URL || 'https://api.typesafe.ai/v1/systemone');
  const proxy = {
    '/jev-api': {
      target: target.origin,
      changeOrigin: true,
      secure: true,
      rewrite: () => target.pathname,
      headers: key ? { Authorization: `Bearer ${key}` } : {},
    },
  };
  return {
    define: {
      __JEV_ENABLED__: JSON.stringify(key.length > 0),
    },
    server: { port: 5173, open: true, proxy },
    preview: { proxy },
    build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  };
});
