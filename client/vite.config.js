import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Same-origin in dev, so the session cookie is sent with every API call.
    // `vite preview` uses the same proxy. SCOPE_ENGINE_URL points it at an
    // engine on another port (the demo launcher and its end-to-end test).
    proxy: { '/api': process.env.SCOPE_ENGINE_URL || 'http://localhost:3001' },
  },
})
