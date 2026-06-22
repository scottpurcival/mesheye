import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';

export default defineConfig({
  plugins: [cesium()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
});
