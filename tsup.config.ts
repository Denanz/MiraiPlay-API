import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Пакеты из npm оставляем внешними — Fastify и компания плохо собираются в
  // бандл. Локальные JSON esbuild всё равно вшивает.
  skipNodeModulesBundle: true,
});
