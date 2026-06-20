import { isBadRequest } from '../errors.ts';
import {
  chunkRich,
  chunkText,
  extractTrailingCover,
  mdToTelegramHtml,
  neutralizeRichMedia,
  repairRichTables,
} from '../format/index.ts';
import type { BotClient, Logger } from './interfaces.ts';

const CAPTION_LIMIT = 1024;

type SendOpts = { rich: boolean; log: Logger };

/** Classic HTML send with HTML→plain 400 fallback (client.ts sendMessage). */
async function sendClassic(
  client: BotClient,
  chatId: number,
  text: string,
  signal?: AbortSignal,
): Promise<void> {
  for (const chunk of chunkText(text)) {
    let html: string | null;
    try {
      html = mdToTelegramHtml(chunk);
    } catch {
      html = null; // totality is pinned by format tests; defence-in-depth
    }
    if (html === null) {
      await client.sendMessage({ chatId, text: chunk }, signal);
      continue;
    }
    try {
      await client.sendMessage(
        { chatId, text: html, parseMode: 'HTML' },
        signal,
      );
    } catch (err) {
      if (!isBadRequest(err)) throw err;
      await client.sendMessage({ chatId, text: chunk }, signal);
    }
  }
}

/** Rich send with rich→classic 400 fallback (client.ts sendRichMessage). */
async function sendRich(
  client: BotClient,
  chatId: number,
  markdown: string,
  log: Logger,
  signal?: AbortSignal,
): Promise<void> {
  for (const piece of chunkRich(
    neutralizeRichMedia(repairRichTables(markdown)),
  )) {
    try {
      await client.sendRichMessage({ chatId, markdown: piece }, signal);
    } catch (err) {
      if (!isBadRequest(err)) throw err;
      log.warn('telegram rich fallback', {
        method: 'sendRichMessage',
        error_code: err.error_code,
        description: err.description,
        chatId,
      });
      await sendClassic(client, chatId, piece, signal);
    }
  }
}

/** Active reply path — rich when opts.rich, else classic. */
export async function sendText(
  client: BotClient,
  chatId: number,
  text: string,
  opts: SendOpts,
  signal?: AbortSignal,
): Promise<void> {
  if (opts.rich) await sendRich(client, chatId, text, opts.log, signal);
  else await sendClassic(client, chatId, text, signal);
}

/** Photo with caption: render caption HTML, retry plain on 400; a plain-retry
 *  400 (bad URL) propagates to sendReply's text fallback (client.ts sendPhoto). */
async function sendCover(
  client: BotClient,
  chatId: number,
  url: string,
  caption: string | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (caption === undefined || caption === '') {
    await client.sendPhoto({ chatId, url }, signal);

    return;
  }
  let html: string | null;
  try {
    html = mdToTelegramHtml(caption);
  } catch {
    html = null;
  }
  if (html === null) {
    await client.sendPhoto({ chatId, url, caption }, signal);

    return;
  }
  try {
    await client.sendPhoto(
      { chatId, url, caption: html, parseMode: 'HTML' },
      signal,
    );
  } catch (err) {
    if (!isBadRequest(err)) throw err;
    await client.sendPhoto({ chatId, url, caption }, signal);
  }
}

/** Final reply send for a completed turn (client.ts sendReply). */
export async function sendReply(
  client: BotClient,
  chatId: number,
  reply: string,
  opts: SendOpts,
  signal?: AbortSignal,
): Promise<void> {
  const cover = extractTrailingCover(reply);
  if (cover === null) {
    await sendText(client, chatId, reply, opts, signal);

    return;
  }
  const longBody = cover.body.length > CAPTION_LIMIT;
  try {
    if (longBody) await sendCover(client, chatId, cover.url, undefined, signal);
    else await sendCover(client, chatId, cover.url, cover.body, signal);
  } catch (err) {
    if (!isBadRequest(err)) throw err;
    await sendText(client, chatId, neutralizeRichMedia(reply), opts, signal);

    return;
  }
  if (longBody) await sendText(client, chatId, cover.body, opts, signal);
}
