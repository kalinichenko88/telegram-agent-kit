import { expect, test } from 'vitest';

import type {
  AgentStream,
  BotClient,
  Checkpointer,
  ThreadStore,
} from '../../src/bridge/interfaces.ts';

test('interfaces are structurally implementable', () => {
  const client: BotClient = {
    sendMessage: async () => {},
    sendRichMessage: async () => {},
    sendPhoto: async () => {},
    sendChatAction: async () => {},
    sendMessageDraft: async () => {},
    sendRichMessageDraft: async () => {},
  };
  const cp: Checkpointer = {
    snapshot: async () => null,
    rollback: async () => {},
  };
  const ts: ThreadStore = { resolve: async () => 't', touch: async () => {} };
  const stream: AgentStream = async function* () {
    yield { type: 'token', text: 'x' };
  };
  expect([client, cp, ts, stream].length).toBe(4);
});
