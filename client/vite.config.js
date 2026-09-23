import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Same-origin in dev, so the session cookie is sent with every API call.
    proxy: { '/api': 'http://localhost:3001' },
  },
})
