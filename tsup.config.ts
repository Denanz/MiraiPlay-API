import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Keep npm deps external (Fastify & co. don't bundle cleanly); local JSON data
  // files are still inlined by esbuild.
  skipNodeModulesBundle: true,
});
