import { expect, test, vi } from 'vitest';
import type { BotClient, Logger } from '../../src/bridge/interfaces.ts';
import { sendReply } from '../../src/bridge/send.ts';
import { TelegramApiError } from '../../src/errors.ts';

const noopLog: Logger = { warn: () => {}, error: () => {} };

function fakeClient(over: Partial<BotClient> = {}): BotClient {
  return {
    sendMessage: vi.fn(async () => {}),
    sendRichMessage: vi.fn(async () => {}),
    sendPhoto: vi.fn(async () => {}),
    sendChatAction: vi.fn(async () => {}),
    sendMessageDraft: vi.fn(async () => {}),
    sendRichMessageDraft: vi.fn(async () => {}),
    ...over,
  };
}

// The rich path fires only for text that NEEDS it — today, a GFM table. Plain
// prose under `rich: true` routes to classic on purpose (see sendText).
const TABLE = '| a | b |\n|---|---|\n| 1 | 2 |';

test('rich reply with no cover goes through sendRichMessage', async () => {
  const c = fakeClient();
  await sendReply(c, 1, `hello **world**\n\n${TABLE}`, {
    rich: true,
    log: noopLog,
  });
  expect(c.sendRichMessage).toHaveBeenCalledTimes(1);
  expect(c.sendPhoto).not.toHaveBeenCalled();
});

test('rich: true still sends table-less prose as classic HTML', async () => {
  const c = fakeClient();
  await sendReply(c, 1, 'hello **world**', { rich: true, log: noopLog });
  expect(c.sendRichMessage).not.toHaveBeenCalled();
  expect(c.sendMessage).toHaveBeenCalledTimes(1);
  expect(c.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ parseMode: 'HTML' }),
    undefined,
  );
});

test('inline media is neutralized on the classic path too', async () => {
  const c = fakeClient();
  await sendReply(c, 1, 'see ![chart](https://x/y.png) here', {
    rich: true,
    log: noopLog,
  });
  // Classic has no image renderer either: without neutralizing, the user sees
  // raw `![chart](…)` markdown.
  const [[sent]] = (c.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
  expect(sent.text).not.toContain('![');
  expect(sent.text).toContain('https://x/y.png');
});

test('rich send 400 falls back to classic sendMessage and warns text-less', async () => {
  const warn = vi.fn();
  const c = fakeClient({
    sendRichMessage: vi.fn(async () => {
      throw new TelegramApiError(400, 'bad');
    }),
  });
  await sendReply(c, 1, TABLE, { rich: true, log: { warn, error: () => {} } });
  expect(c.sendMessage).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(
    'telegram rich fallback',
    expect.objectContaining({
      method: 'sendRichMessage',
      error_code: 400,
      chatId: 1,
    }),
  );
  // the warn payload must NOT carry the message text
  expect(warn.mock.calls[0]?.[1]).not.toHaveProperty('text');
  expect(warn.mock.calls[0]?.[1]).not.toHaveProperty('markdown');
});

test('trailing cover sends a photo', async () => {
  const c = fakeClient();
  await sendReply(c, 1, 'caption body\n\n![c](https://x/y.png)', {
    rich: true,
    log: noopLog,
  });
  expect(c.sendPhoto).toHaveBeenCalledTimes(1);
});

test('sendPhoto 400 falls back to neutralized text', async () => {
  const c = fakeClient({
    sendPhoto: vi.fn(async () => {
      throw new TelegramApiError(400, 'bad url');
    }),
  });
  await sendReply(c, 1, `${TABLE}\n\n![c](https://x/y.png)`, {
    rich: true,
    log: noopLog,
  });
  expect(c.sendRichMessage).toHaveBeenCalled(); // neutralized text via rich path
});

test('non-400 error propagates (no double-send)', async () => {
  const c = fakeClient({
    sendRichMessage: vi.fn(async () => {
      throw new Error('network');
    }),
  });
  await expect(
    sendReply(c, 1, TABLE, { rich: true, log: noopLog }),
  ).rejects.toThrow('network');
  expect(c.sendMessage).not.toHaveBeenCalled();
});

// 2026-07-30 review: the blank guard belonged in the funnel that throws, not
// only in the turn loop — background callers (an app's digest / nudge jobs) hand
// model output straight to sendReply, so a chain that goes mute end to end threw
// `400 text must be non-empty` out of the job's send instead of skipping.
test('an invisible-only reply sends nothing at all', async () => {
  const c = fakeClient();
  await sendReply(c, 1, '​​', { rich: true, log: noopLog });
  expect(c.sendMessage).not.toHaveBeenCalled();
  expect(c.sendRichMessage).not.toHaveBeenCalled();
  expect(c.sendPhoto).not.toHaveBeenCalled();
});

test('whitespace-only likewise, and a real reply still goes out', async () => {
  const c = fakeClient();
  await sendReply(c, 1, '   \n\t ', { rich: false, log: noopLog });
  expect(c.sendMessage).not.toHaveBeenCalled();
  await sendReply(c, 1, 'real', { rich: false, log: noopLog });
  expect(c.sendMessage).toHaveBeenCalledTimes(1);
});

test('a cover-image-only reply is NOT blocked by the blank guard', async () => {
  // The body is empty but the reply is not: the photo IS the message. Guarding
  // in sendText rather than sendReply is what keeps this path working.
  const c = fakeClient();
  await sendReply(c, 1, '![cat](https://example.com/cat.jpg)', {
    rich: true,
    log: noopLog,
  });
  expect(c.sendPhoto).toHaveBeenCalledTimes(1);
});

test('an emoji-only reply is real content, not blank', async () => {
  // \p{Cf} covers the ZWJ inside 👨‍👩‍👧 — stripping it for the test must not
  // make a legitimate emoji reply look empty.
  const c = fakeClient();
  await sendReply(c, 1, '👨‍👩‍👧', { rich: false, log: noopLog });
  expect(c.sendMessage).toHaveBeenCalledTimes(1);
});
