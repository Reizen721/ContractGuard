import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.component.test.ts'],
    pool: 'threads',
    maxWorkers: 1,
    restoreMocks: true,
  },
})
