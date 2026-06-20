import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

// The optional peers (@langchain/core, deepagents) are used ONLY as type
// imports, so both entries import cleanly and — crucially — the built
// /deepagents bundle carries no runtime import of either peer.

test('main entry imports and exposes runTelegramTurn', async () => {
  const mod = await import('../../src/index.ts');
  expect(typeof mod.runTelegramTurn).toBe('function');
});

test('/deepagents subpath imports and exposes its adapters', async () => {
  const mod = await import('../../src/deepagents/index.ts');
  expect(typeof mod.toAgentStream).toBe('function');
  expect(typeof mod.streamAgent).toBe('function');
});

test('built /deepagents bundle has no runtime import of the optional peers', () => {
  const dist = fileURLToPath(
    new URL('../../dist/deepagents/index.js', import.meta.url),
  );
  if (!existsSync(dist)) return; // build not run yet — CI builds before testing
  const js = readFileSync(dist, 'utf8');
  expect(js).not.toMatch(/from\s+['"]@langchain\/core/);
  expect(js).not.toMatch(/from\s+['"]deepagents['"]/);
});
