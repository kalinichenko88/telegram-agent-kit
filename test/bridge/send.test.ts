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

test('rich reply with no cover goes through sendRichMessage', async () => {
  const c = fakeClient();
  await sendReply(c, 1, 'hello **world**', { rich: true, log: noopLog });
  expect(c.sendRichMessage).toHaveBeenCalledTimes(1);
  expect(c.sendPhoto).not.toHaveBeenCalled();
});

test('rich send 400 falls back to classic sendMessage and warns text-less', async () => {
  const warn = vi.fn();
  const c = fakeClient({
    sendRichMessage: vi.fn(async () => {
      throw new TelegramApiError(400, 'bad');
    }),
  });
  await sendReply(c, 1, 'hi', { rich: true, log: { warn, error: () => {} } });
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
  await sendReply(c, 1, 'body\n\n![c](https://x/y.png)', {
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
    sendReply(c, 1, 'hi', { rich: true, log: noopLog }),
  ).rejects.toThrow('network');
  expect(c.sendMessage).not.toHaveBeenCalled();
});
