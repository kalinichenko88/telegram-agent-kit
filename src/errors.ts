/** Thrown by BotClient transport primitives on a Bot API error. The
 *  `error_code` is the Bot API numeric code; 400 is the deterministic
 *  "rejected, not delivered" class the kit's fallbacks key off. */
export class TelegramApiError extends Error {
  constructor(
    readonly error_code: number,
    readonly description?: string,
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
