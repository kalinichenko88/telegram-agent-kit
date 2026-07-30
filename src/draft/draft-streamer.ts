import type { BotClient, Logger } from '../bridge/interfaces.ts';
import { isBadRequest } from '../errors.ts';
import { safeSlice } from '../format/chunk.ts';
import { needsRich } from '../format/rich.ts';
import { DEFAULT_DRAFT_CONSTANTS, type DraftConstants } from './constants.ts';

export type DraftStreamerDeps = {
  client: Pick<
    BotClient,
    'sendMessageDraft' | 'sendRichMessageDraft' | 'sendChatAction'
  >;
  chatId: number;
  draftId: number; // non-zero; reused for every write of one turn (animation)
  rich: boolean; // true = rich mode; false (kill-switch active) → plain from the start
  log: Logger;
  /** Override any subset of the draft tunables; defaults fill the rest. */
  constants?: Partial<DraftConstants>;
};

export type DraftStreamer = {
  start(): void;
  push(fullText: string): void;
  finalize(): Promise<void>;
  abort(): Promise<void>;
};

export function createDraftStreamer(deps: DraftStreamerDeps): DraftStreamer {
  const k = { ...DEFAULT_DRAFT_CONSTANTS, ...deps.constants };
  const now = Date.now;
  const { client, chatId, draftId, log } = deps;

  let latest = '';
  let lastSent: string | null = null;
  let lastSentAt = 0;
  let lastAttemptAt = Number.NEGATIVE_INFINITY; // first push flushes even at now()===0
  let lastTypingAt = 0;
  let inFlight: Promise<void> | null = null;
  let inFlightController: AbortController | null = null;
  let consecutiveFailures = 0;
  let disabled = false;
  let richMode = deps.rich; // turn-scoped: flips to plain on a 400
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  function send(text: string, t: number): void {
    const controller = new AbortController();
    inFlightController = controller;
    lastAttemptAt = t;
    // Same gate as the final send: rich only for text that needs it. Without it
    // the draft animates a whole turn in the rich renderer's body font and then
    // the final message lands in the normal one — the mismatch is the visible
    // half of the problem. Re-evaluated per write, so a draft flips to rich the
    // moment a table's delimiter row streams in.
    const usingRich = richMode && needsRich(text);
    const op = usingRich
      ? client.sendRichMessageDraft(
          { chatId, draftId, markdown: text },
          controller.signal,
        )
      : client.sendMessageDraft({ chatId, draftId, text }, controller.signal);
    inFlight = op
      .then(() => {
        lastSent = text; // raw; the keepalive re-sends it via the current mode
        lastSentAt = now();
        consecutiveFailures = 0;
      })
      .catch((err) => {
        if (controller.signal.aborted) return; // our own abort — not a failure
        if (usingRich && isBadRequest(err)) {
          // Rich rejected, transport healthy: plain for the rest of the turn,
          // without burning the maxFailures budget.
          richMode = false;
          log.warn('telegram draft rich disabled', {
            chat_id: chatId,
            method: 'sendRichMessageDraft',
            error_code: err.error_code,
            description: err.description,
          });

          return;
        }
        consecutiveFailures += 1;
        if (consecutiveFailures >= k.maxFailures) {
          disabled = true;
          log.warn('telegram draft disabled after failures', {
            chat_id: chatId,
            failures: consecutiveFailures,
          });
        } else {
          log.warn('telegram draft send failed', { chat_id: chatId });
        }
      })
      .finally(() => {
        inFlight = null;
        inFlightController = null;
      });
  }

  function maybeFlush(): void {
    if (stopped || disabled || inFlight) return;
    const t = now();
    if (
      latest !== lastSent &&
      latest.trim().length > 0 &&
      t - lastAttemptAt >= k.throttleMs
    ) {
      send(latest, t);
    } else if (lastSent !== null && t - lastSentAt >= k.keepaliveMs) {
      send(lastSent, t); // keepalive — beat the ~30s draft expiry
    }
  }

  function tick(): void {
    maybeFlush();
    if (!stopped && now() - lastTypingAt >= k.typingHeartbeatMs) {
      client.sendChatAction({ chatId }).catch(() => {});
      lastTypingAt = now();
    }
  }

  return {
    start(): void {
      lastTypingAt = now();
      client.sendChatAction({ chatId }).catch(() => {});
      timer = setInterval(tick, k.tickMs);
    },

    push(fullText: string): void {
      latest = safeSlice(fullText, k.previewCap);
      maybeFlush();
    },

    async finalize(): Promise<void> {
      try {
        stopped = true;
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
        if (!inFlight) return;
        let drainTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          const landed = await Promise.race([
            inFlight.then(() => true),
            new Promise<false>((resolve) => {
              drainTimer = setTimeout(() => resolve(false), k.drainMs);
            }),
          ]);
          if (!landed) {
            inFlightController?.abort();
            await inFlight?.catch(() => {});
          }
        } finally {
          clearTimeout(drainTimer); // clear the drain timer on both paths — no leak
        }
      } catch (err) {
        log.warn('telegram draft finalize error', { err: String(err) });
      }
    },

    async abort(): Promise<void> {
      try {
        stopped = true;
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
        inFlightController?.abort();
        await inFlight?.catch(() => {});
      } catch (err) {
        log.warn('telegram draft abort error', { err: String(err) });
      }
    },
  };
}
