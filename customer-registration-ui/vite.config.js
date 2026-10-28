import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Standalone customer registration UI. The main portal (frontend/) keeps port 5173;
// this app uses 5174 and fails loudly instead of moving to another port.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5174,
    strictPort: true,
    // Used only in api mode (VITE_REGISTRATION_MODE=api). Demo mode makes no requests.
    // Points at the local development B2C server, never at a deployed one.
    proxy: {
      '/api/b2c': { target: process.env.B2C_DEV_TARGET || 'http://localhost:5100', changeOrigin: true }
    }
  },
  preview: {
    port: 4174,
    strictPort: true
  }
})
