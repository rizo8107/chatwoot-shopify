import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        // Keep the local API separate from other apps that commonly use 3000.
        // This must match PORT in the repository's development .env file.
        target: 'http://localhost:3001',
        changeOrigin: true,
      }
    }
  }
})
