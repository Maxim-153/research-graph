import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Прокси /api → бэкенд: фронт и API становятся одним источником, поэтому
    // при удалённом проведении эксперимента (см. docs/thesis/experiment-protocol.md)
    // хватает ОДНОГО туннеля и не нужна настройка CORS. На обычный локальный
    // запуск (npm run dev, открытие через localhost) не влияет.
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
    // Разрешить заходить на dev-сервер через туннель (cloudflared/ngrok).
    // Снимает защиту от DNS-rebinding — держать включённым только на время
    // сессий эксперимента.
    allowedHosts: true,
  },
})
