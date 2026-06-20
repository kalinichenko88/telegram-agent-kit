import { expect, test } from 'vitest';

import { __kit } from '../src/index.ts';

test('package builds and imports', () => {
  expect(__kit).toBe('telegram-agent-kit');
});
