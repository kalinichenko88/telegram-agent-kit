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
  // 'hello' is table-less prose, so even under rich: true it goes out classic.
  expect(d.client.sendMessage).toHaveBeenCalled();
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

test('error event → logs the message and sends errorNotice as plain text', async () => {
  const stream: AgentStream = async function* () {
    yield { type: 'error', message: 'boom' };
  };
  const error = vi.fn();
  const d = deps({
    agentStream: stream,
    errorNotice: 'нет связи с моделью, повтори',
    log: { warn: () => {}, error },
  });
  await runTelegramTurn(d);
  expect(error).toHaveBeenCalledWith(
    'telegram turn errored',
    expect.objectContaining({ err: 'boom' }),
  );
  expect(d.client.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      chatId: 1,
      text: 'нет связи с моделью, повтори',
    }),
    undefined,
  );
  expect(d.client.sendRichMessage).not.toHaveBeenCalled();
});

test('errorNotice is skipped when the turn was aborted via signal', async () => {
  const stream: AgentStream = async function* () {
    yield { type: 'error', message: 'canceled' };
  };
  const d = deps({
    agentStream: stream,
    errorNotice: 'oops',
    signal: AbortSignal.abort(),
  });
  await runTelegramTurn(d);
  expect(d.client.sendMessage).not.toHaveBeenCalled();
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

/** Every draft frame the turn actually pushed to Telegram, in order, across
 *  both the plain and rich draft transports. Tests that inspect frames run with
 *  `throttleMs: 0` so each push flushes instead of being coalesced by the gate. */
function draftFrames(client: BotClient): string[] {
  const calls = [
    ...(client.sendMessageDraft as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => [c[0].text, c] as const,
    ),
    ...(client.sendRichMessageDraft as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => [c[0].markdown, c] as const,
    ),
  ];
  return calls.map(([text]) => text as string);
}

/** Lets the draft streamer's in-flight promise settle between stream events, so
 *  a push is never dropped merely because the previous write is still pending. */
const settle = () => new Promise((r) => setTimeout(r, 1));

test('tool_start status never leaks into the sent reply', async () => {
  const stream: AgentStream = async function* () {
    yield { type: 'token', text: 'one ' };
    yield { type: 'tool_start', name: 'web_search' };
    yield { type: 'token', text: 'two' };
  };
  const d = deps({ agentStream: stream });
  await runTelegramTurn(d);

  // The whole point: the persisted message is exactly the tokens.
  expect(d.client.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ text: 'one two' }),
    undefined,
  );
  expect(d.client.sendRichMessage).not.toHaveBeenCalled();
});

test('a token after a tool_start clears the status from the draft', async () => {
  const stream: AgentStream = async function* () {
    yield { type: 'token', text: 'one ' };
    await settle();
    yield { type: 'tool_start', name: 'web_search' };
    await settle();
    yield { type: 'token', text: 'two' };
    await settle();
  };
  const d = deps({ agentStream: stream, draftConstants: { throttleMs: 0 } });
  await runTelegramTurn(d);

  const frames = draftFrames(d.client);
  // The status was visible mid-turn...
  expect(frames.some((f) => f.includes('🔧') && f.includes('web_search'))).toBe(
    true,
  );
  // ...and the next token replaced it rather than stacking under it.
  expect(frames.at(-1)).toBe('one two');
});

test('a turn ending on a tool_start does not leave 🔧 as the last draft frame', async () => {
  const stream: AgentStream = async function* () {
    yield { type: 'token', text: 'thinking ' };
    await settle();
    yield { type: 'tool_start', name: 'web_search' };
    await settle();
  };
  const d = deps({ agentStream: stream, draftConstants: { throttleMs: 0 } });
  await runTelegramTurn(d);

  expect(draftFrames(d.client).at(-1)).toBe('thinking ');
});

test('a tool-only turn clears the draft, warns, and sends nothing', async () => {
  const stream: AgentStream = async function* () {
    yield { type: 'tool_start', name: 'web_search' };
    await settle();
  };
  const warn = vi.fn();
  const d = deps({
    agentStream: stream,
    draftConstants: { throttleMs: 0 },
    log: { warn, error: () => {} },
  });
  await runTelegramTurn(d);

  expect(warn).toHaveBeenCalledWith('telegram empty reply', { chatId: 1 });
  expect(d.client.sendMessage).not.toHaveBeenCalled();
  expect(d.client.sendRichMessage).not.toHaveBeenCalled();
  // Nothing is sent, so an uncleared 🔧 would stand on screen unexplained.
  expect(draftFrames(d.client).at(-1)).toBe('');
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
