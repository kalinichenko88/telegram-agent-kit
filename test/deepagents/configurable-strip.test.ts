import { expect, test } from 'vitest';

import { stripReservedKeys } from '../../src/deepagents/to-agent-stream.ts';

test('stripReservedKeys returns {} for an empty bag', () => {
  expect(stripReservedKeys({})).toEqual({});
});

test('stripReservedKeys returns {} when every key is reserved', () => {
  expect(
    stripReservedKeys({
      thread_id: 'x',
      checkpoint_id: 'cp',
      checkpoint_ns: 'ns',
      checkpoint_map: {},
      run_id: 'r',
    }),
  ).toEqual({});
});

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

test('stripReservedKeys strips thread_ts (legacy checkpoint_id alias)', () => {
  expect(
    stripReservedKeys({ pendingImages: ['img1'], thread_ts: 'old-cp' }),
  ).toEqual({ pendingImages: ['img1'] });
});

test('stripReservedKeys strips LangGraph internal __pregel_* keys', () => {
  const result = stripReservedKeys({
    pendingImages: ['img1'],
    __pregel_checkpointer: { rogue: true },
    __pregel_read: () => null,
    __pregel_scratchpad: {},
  });
  expect(result).toEqual({ pendingImages: ['img1'] });
  expect(result).not.toHaveProperty('__pregel_checkpointer');
  expect(result).not.toHaveProperty('__pregel_read');
  expect(result).not.toHaveProperty('__pregel_scratchpad');
});

test('stripReservedKeys keeps a caller key that merely contains "pregel"', () => {
  // The strip is prefix-anchored: only keys starting with `__pregel_` go.
  expect(stripReservedKeys({ pregelHint: 1, my__pregel_thing: 2 })).toEqual({
    pregelHint: 1,
    my__pregel_thing: 2,
  });
});

test('pendingImages survives when all reserved keys are also present', () => {
  const result = stripReservedKeys({
    pendingImages: ['img1', 'img2'],
    thread_id: 'caller-owns-this',
    thread_ts: 'old-cp',
    checkpoint_id: 'cp-1',
    checkpoint_ns: 'ns',
    checkpoint_map: { a: 'b' },
    run_id: 'r1',
    __pregel_checkpointer: { rogue: true },
  });
  expect(result).toEqual({ pendingImages: ['img1', 'img2'] });
  expect(result).not.toHaveProperty('thread_id');
  expect(result).not.toHaveProperty('thread_ts');
  expect(result).not.toHaveProperty('checkpoint_id');
  expect(result).not.toHaveProperty('checkpoint_ns');
  expect(result).not.toHaveProperty('checkpoint_map');
  expect(result).not.toHaveProperty('run_id');
  expect(result).not.toHaveProperty('__pregel_checkpointer');
});
