import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom', 'react-router-dom', 'recharts']
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: ['.loca.lt', '.localtunnel.me', '.devtunnels.ms', '.app.github.dev'],
    proxy: {
      // Listed before '/api' so B2C calls reach the separate B2C server.
      '/api/b2c': { target: process.env.B2C_DEV_TARGET || 'http://localhost:5100', changeOrigin: true },
      '/api': { target: 'http://localhost:5000', changeOrigin: true },
      '/uploads': { target: 'http://localhost:5000', changeOrigin: true }
    }
  }
})
