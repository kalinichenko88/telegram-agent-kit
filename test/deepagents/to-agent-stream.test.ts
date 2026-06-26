import { expect, test, vi } from 'vitest';

import * as streamAgentMod from '../../src/deepagents/stream-agent.ts';
import { toAgentStream } from '../../src/deepagents/to-agent-stream.ts';

test('toAgentStream: pendingImages reaches RunnableConfig; caller thread_id/checkpoint_id dropped for kit threadId', async () => {
  const spy = vi
    .spyOn(streamAgentMod, 'streamAgent')
    .mockImplementation(async function* () {});

  const stream = toAgentStream({} as never);
  const input = { messages: [{ role: 'user' as const, content: 'hi' }] };

  for await (const _ of stream(input, {
    threadId: 'kit-thread',
    configurable: {
      pendingImages: ['img1'],
      thread_id: 'caller-thread',
      checkpoint_id: 'cp',
    },
  })) {
    // drain
  }

  expect(spy).toHaveBeenCalledWith(
    expect.anything(),
    input,
    { configurable: { pendingImages: ['img1'], thread_id: 'kit-thread' } },
    undefined,
  );

  spy.mockRestore();
});
