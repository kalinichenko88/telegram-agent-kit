import { expect, test } from 'vitest';

import { stripReservedKeys } from '../../src/deepagents/to-agent-stream.ts';

test('stripReservedKeys passes through non-reserved keys unchanged', () => {
  expect(stripReservedKeys({ pendingImages: ['img1'], foo: 'bar' })).toEqual({
    pendingImages: ['img1'],
    foo: 'bar',
  });
});

test('stripReservedKeys strips thread_id', () => {
  expect(
    stripReservedKeys({ pendingImages: ['img1'], thread_id: 'x' }),
  ).toEqual({
    pendingImages: ['img1'],
  });
});

test('stripReservedKeys strips checkpoint_id, checkpoint_ns, checkpoint_map, run_id', () => {
  expect(
    stripReservedKeys({
      pendingImages: ['img1'],
      checkpoint_id: 'cp',
      checkpoint_ns: 'ns',
      checkpoint_map: {},
      run_id: 'r',
    }),
  ).toEqual({ pendingImages: ['img1'] });
});

test('pendingImages survives when all reserved keys are also present', () => {
  const result = stripReservedKeys({
    pendingImages: ['img1', 'img2'],
    thread_id: 'caller-owns-this',
    checkpoint_id: 'cp-1',
    checkpoint_ns: 'ns',
    checkpoint_map: { a: 'b' },
    run_id: 'r1',
  });
  expect(result).toEqual({ pendingImages: ['img1', 'img2'] });
  expect(result).not.toHaveProperty('thread_id');
  expect(result).not.toHaveProperty('checkpoint_id');
  expect(result).not.toHaveProperty('checkpoint_ns');
  expect(result).not.toHaveProperty('checkpoint_map');
  expect(result).not.toHaveProperty('run_id');
});
