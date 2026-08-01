/** Thrown by BotClient transport primitives on a Bot API error. The
 *  `error_code` is the Bot API numeric code; 400 is the deterministic
 *  "rejected, not delivered" class the kit's fallbacks key off. Pass the Bot
 *  API's `parameters` object straight through — on a 429 its `retry_after`
 *  (seconds) is exactly how long the draft streamer waits before writing
 *  again, so dropping it costs the draft the rest of the turn. */
export class TelegramApiError extends Error {
  constructor(
    readonly error_code: number,
    readonly description?: string,
    readonly parameters?: { retry_after?: number },
  ) {
    super(`telegram api ${error_code}${description ? `: ${description}` : ''}`);
    this.name = 'TelegramApiError';
  }
}

/** True only for a deterministic 400 (rejected, not delivered) — safe to
 *  retry on a degraded path without risking a double-send. */
export function isBadRequest(err: unknown): err is TelegramApiError {
  return err instanceof TelegramApiError && err.error_code === 400;
}

/** True for a 429 — throttled, not rejected. The transport is healthy and the
 *  API told us how long to wait, so this is never a failure to count against a
 *  retry budget. */
export function isRateLimited(err: unknown): err is TelegramApiError {
  return err instanceof TelegramApiError && err.error_code === 429;
}
