import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.js';

// Component and unit tests run in jsdom; the browser smoke test lives in
// e2e/ and runs under Playwright instead.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.js'],
      include: ['src/**/*.test.{js,jsx}'],
      restoreMocks: true,
    },
  })
);
