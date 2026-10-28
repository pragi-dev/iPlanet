import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const apiTarget = process.env.API_DEV_TARGET || 'http://localhost:5000'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom', 'react-router-dom', 'recharts']
  },
  server: {
    host: '0.0.0.0',
    port: Number(process.env.VITE_PORT) || 5173,
    strictPort: true,
    allowedHosts: ['.loca.lt', '.localtunnel.me', '.devtunnels.ms', '.app.github.dev'],
    proxy: {
      // Listed before '/api' so B2C calls reach the separate B2C server.
      '/api/b2c': { target: process.env.B2C_DEV_TARGET || 'http://localhost:5100', changeOrigin: true },
      '/api': { target: apiTarget, changeOrigin: true },
      '/uploads': { target: apiTarget, changeOrigin: true }
    }
  }
})
