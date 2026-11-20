import { expect, test } from 'vitest';

import * as format from '../src/format/index.ts';
import * as root from '../src/index.ts';

// The root re-exports format by name. A new format export fails here until
// it is listed in src/index.ts or named below as internal.
const INTERNAL_FORMAT_EXPORTS = ['CHUNK_TARGET'];

test('the root publishes every format export but the internal ones', () => {
  const published = Object.keys(format).filter(
    (name) => !INTERNAL_FORMAT_EXPORTS.includes(name),
  );
  expect(Object.keys(root)).toEqual(expect.arrayContaining(published));
  for (const name of INTERNAL_FORMAT_EXPORTS)
    expect(root).not.toHaveProperty(name);
});
