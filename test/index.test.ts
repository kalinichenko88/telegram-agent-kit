import { expect, test } from 'vitest';

import * as format from '../src/format/index.ts';
import * as root from '../src/index.ts';

// The root re-exports format by name. A new value export of format fails here
// until src/index.ts lists it, or this test names it as internal. Types do not
// exist at runtime: a new type export is public only when src/index.ts lists
// it, and no test checks that.
test('the root publishes every format export but CHUNK_TARGET', () => {
  const published = Object.keys(format).filter(
    (name) => name !== 'CHUNK_TARGET',
  );
  expect(Object.keys(root)).toEqual(expect.arrayContaining(published));
  expect(root).not.toHaveProperty('CHUNK_TARGET');
});
