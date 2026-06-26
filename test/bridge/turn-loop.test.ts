import { expect, test, vi } from 'vitest';

import type {
  AgentStream,
  BotClient,
  Checkpointer,
  ThreadStore,
} from '../../src/bridge/interfaces.ts';
import { runTelegramTurn } from '../../src/bridge/turn-loop.ts';

const noopLog = { warn: () => {}, error: () => {} };

function deps(over: Record<string, unknown> = {}) {
  const client: BotClient = {
    sendMessage: vi.fn(async () => {}),
    sendRichMessage: vi.fn(async () => {}),
    sendPhoto: vi.fn(async () => {}),
    sendChatAction: vi.fn(async () => {}),
    sendMessageDraft: vi.fn(async () => {}),
    sendRichMessageDraft: vi.fn(async () => {}),
  };
  const checkpointer: Checkpointer = {
    snapshot: vi.fn(async () => 'cp-1'),
    rollback: vi.fn(async () => {}),
  };
  const threadStore: ThreadStore = {
    resolve: vi.fn(async () => 'tg-1-main'),
    touch: vi.fn(async () => {}),
  };
  const okStream: AgentStream = async function* () {
    yield { type: 'token', text: 'hello' };
  };
  return {
    chatKey: { chatId: 1, agentId: 'main' },
    userText: 'hi',
    draftId: 7,
    rich: true,
    client,
    agentStream: okStream,
    checkpointer,
    threadStore,
    log: noopLog,
    ...over,
  } as Parameters<typeof runTelegramTurn>[0];
}

test('happy path: streams, finalizes, sends reply, touches, no rollback', async () => {
  const d = deps();
  await runTelegramTurn(d);
  expect(d.client.sendRichMessage).toHaveBeenCalled();
  expect(d.threadStore.touch).toHaveBeenCalled();
  expect(d.checkpointer.rollback).not.toHaveBeenCalled();
});

test('threadId from threadStore.resolve reaches the AgentStream context', async () => {
  const seen: string[] = [];
  const stream: AgentStream = async function* (_input, ctx) {
    seen.push(ctx.threadId);
    yield { type: 'token', text: 'x' };
  };
  await runTelegramTurn(deps({ agentStream: stream }));
  expect(seen).toEqual(['tg-1-main']);
});

test('error event → abort + rollback to snapshot, no reply', async () => {
  const stream: AgentStream = async function* () {
    yield { type: 'error', message: 'boom' };
  };
  const d = deps({ agentStream: stream });
  await runTelegramTurn(d);
  expect(d.checkpointer.rollback).toHaveBeenCalledWith('tg-1-main', 'cp-1');
  expect(d.client.sendRichMessage).not.toHaveBeenCalled();
});

test('throw mid-stream → rollback, never rethrows', async () => {
  const stream: AgentStream = async function* () {
    yield { type: 'token', text: 'partial' };
    throw new Error('mid');
  };
  const d = deps({ agentStream: stream });
  await expect(runTelegramTurn(d)).resolves.toBeUndefined();
  expect(d.checkpointer.rollback).toHaveBeenCalledWith('tg-1-main', 'cp-1');
});

test('post-completion send failure is NOT rolled back', async () => {
  const client = deps().client;
  (client.sendRichMessage as ReturnType<typeof vi.fn>).mockRejectedValue(
    new Error('send fail'),
  );
  const d = deps({ client });
  await expect(runTelegramTurn(d)).resolves.toBeUndefined();
  expect(d.checkpointer.rollback).not.toHaveBeenCalled();
});

test('preStream { skip:true } ends the turn before snapshot', async () => {
  const d = deps({ hooks: { preStream: () => ({ skip: true }) } });
  await runTelegramTurn(d);
  expect(d.checkpointer.snapshot).not.toHaveBeenCalled();
  expect(d.client.sendRichMessage).not.toHaveBeenCalled();
});

test('a throwing afterTurn hook is swallowed (never throws out)', async () => {
  const d = deps({
    hooks: {
      afterTurn: () => {
        throw new Error('after');
      },
    },
  });
  await expect(runTelegramTurn(d)).resolves.toBeUndefined();
});

test('opts.configurable is forwarded to agentStream context', async () => {
  let capturedConfigurable: Record<string, unknown> | undefined;
  const stream: AgentStream = async function* (_input, ctx) {
    capturedConfigurable = ctx.configurable;
    yield { type: 'token', text: 'ok' };
  };
  await runTelegramTurn(
    deps({ agentStream: stream, configurable: { pendingImages: ['img1'] } }),
  );
  expect(capturedConfigurable).toEqual({ pendingImages: ['img1'] });
});

test('context.configurable is undefined when opts.configurable is not set', async () => {
  let capturedConfigurable: Record<string, unknown> | undefined;
  const stream: AgentStream = async function* (_input, ctx) {
    capturedConfigurable = ctx.configurable;
    yield { type: 'token', text: 'ok' };
  };
  await runTelegramTurn(deps({ agentStream: stream }));
  expect(capturedConfigurable).toBeUndefined();
});
