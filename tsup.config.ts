import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', 'deepagents/index': 'src/deepagents/index.ts' },
  format: ['esm'],
  dts: true,
  clean: true,
  // Optional peers are type-only in source, but externalize defensively so
  // they are never bundled even if a value import sneaks in.
  external: ['@langchain/core', 'deepagents'],
});
