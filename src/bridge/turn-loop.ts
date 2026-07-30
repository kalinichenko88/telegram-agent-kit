import {
  createDraftStreamer,
  type DraftConstants,
  type DraftStreamer,
} from '../draft/index.ts';
import type {
  AgentStream,
  BotClient,
  ChatKey,
  Checkpointer,
  Logger,
  ThreadStore,
} from './interfaces.ts';
import { sendReply } from './send.ts';

export type TurnContext = { chatKey: ChatKey; userText: string };

export type RunTelegramTurnOpts = {
  chatKey: ChatKey;
  userText: string;
  draftId: number;
  rich: boolean;
  client: BotClient;
  agentStream: AgentStream;
  checkpointer: Checkpointer;
  threadStore: ThreadStore;
  signal?: AbortSignal;
  now?: () => number;
  log?: Logger;
  hooks?: {
    preStream?: (
      ctx: TurnContext,
      // biome-ignore lint/suspicious/noConfusingVoidType: `void` (not `undefined`) so a hook may return any value and have it ignored — narrowing to `undefined` would reject that.
    ) => void | { skip?: boolean } | Promise<void | { skip?: boolean }>;
    beforeTurn?: (ctx: TurnContext) => void | Promise<void>;
    afterTurn?: (ctx: TurnContext) => void | Promise<void>;
  };
  draftConstants?: Partial<DraftConstants>;
  configurable?: Record<string, unknown>;
  /** Plain-text line sent to the chat when the stream errors out (model chain
   *  exhausted, graph threw). Without it the turn returns silently and the user
   *  sees only a draft that stops moving — indistinguishable from being ignored. */
  errorNotice?: string;
  /** Plain-text line sent when the turn COMPLETES with nothing to say — it ended
   *  on a tool call, or the model answered with invisible characters only.
   *  Deliberately a separate line from `errorNotice`: this turn was not rolled
   *  back, so whatever its tools wrote stands, and words like "it broke" invite a
   *  re-send that logs the same thing twice. */
  emptyNotice?: string;
};

const NOOP_LOG: Logger = { warn: () => {}, error: () => {} };

/** Is this reply empty as far as Telegram is concerned? `\p{Cf}` are the
 *  invisible format characters (U+200B zero-width space, U+FEFF, U+2060, soft
 *  hyphen …), which `String.trim` does NOT strip but the Bot API discards: a
 *  message made of nothing else comes back `400 text must be non-empty`, on the
 *  HTML send and again on the plain-text fallback, and the second throw escapes
 *  the whole turn. 2026-07-30 prod: a local fallback model answered a
 *  food-logging turn with a bare U+200B — the diary row was written, the send
 *  threw past `sendReply`, and the user got silence with no notice.
 *  Used ONLY as a predicate, never to rewrite the outgoing text: `\p{Cf}` also
 *  covers the ZWJ that holds emoji sequences together. */
function isBlankReply(reply: string): boolean {
  return reply.replace(/\p{Cf}/gu, '').trim() === '';
}

/** Skills load via progressive disclosure — the model reads
 *  `/skills/<name>/SKILL.md` with `read_file` (no dedicated tool). */
export function skillName(name: string, args: unknown): string | null {
  if (name !== 'read_file') return null;
  return (
    (args as { file_path?: string } | undefined)?.file_path?.match(
      /\/skills\/([^/]+)\/SKILL\.md$/,
    )?.[1] ?? null
  );
}

export async function runTelegramTurn(
  opts: RunTelegramTurnOpts,
): Promise<void> {
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? NOOP_LOG;
  const ctx: TurnContext = { chatKey: opts.chatKey, userText: opts.userText };

  let rollback: { threadId: string; checkpointId: string | null } | null = null;
  let turnCompleted = false;
  let draft: DraftStreamer | null = null;
  let draftTornDown = false;

  try {
    // 1. beforeTurn — isolated; never aborts the turn.
    if (opts.hooks?.beforeTurn) {
      try {
        await opts.hooks.beforeTurn(ctx);
      } catch (err) {
        log.error('telegram beforeTurn hook failed', { err: String(err) });
      }
    }

    // 2. preStream — before any snapshot, outside rollback. Sync-throw safe.
    if (opts.hooks?.preStream) {
      let res: { skip?: boolean } | undefined;
      try {
        res = (await opts.hooks.preStream(ctx)) ?? undefined;
      } catch (err) {
        log.error('telegram preStream hook failed', { err: String(err) });
        res = undefined;
      }
      if (res?.skip) return;
    }

    // 3. resolve thread.
    const threadId = await opts.threadStore.resolve(opts.chatKey, now());

    // 4. snapshot — set the rollback target only now.
    const checkpointId = await opts.checkpointer.snapshot(threadId);
    rollback = { threadId, checkpointId };

    // 5. start the draft streamer.
    draft = createDraftStreamer({
      client: opts.client,
      chatId: opts.chatKey.chatId,
      draftId: opts.draftId,
      rich: opts.rich,
      log,
      constants: opts.draftConstants,
    });
    draft.start();

    // 6. stream. `status` is draft-only scaffolding — it is composed onto the
    //    pushed frame but never onto `reply`, so tool narration can animate
    //    live without ever reaching the persisted message.
    let reply = '';
    let status = '';
    let errorMessage: string | undefined;
    for await (const ev of opts.agentStream(
      { messages: [{ role: 'user', content: opts.userText }] },
      { threadId, signal: opts.signal, configurable: opts.configurable },
    )) {
      if (ev.type === 'token') {
        reply += ev.text;
        status = ''; // the answer resumed — drop the tool line, don't stack under it
        draft.push(reply);
      } else if (ev.type === 'tool_start') {
        const skill = skillName(ev.name, ev.args);
        status =
          skill !== null
            ? `🧠 load_skill(\`${skill}\`)…`
            : `🔧 \`${ev.name}\`…`;
        draft.push(reply ? `${reply}\n\n${status}` : status);
      } else if (ev.type === 'error') errorMessage = ev.message;
    }

    // 7. errored → log, abort, rollback, tell the user.
    if (errorMessage !== undefined) {
      // The message is the ONLY record of why the turn died: the stream swallows
      // the original throw into this event, and rollback then erases the turn from
      // history. Drop it here and the failure is unobservable after the fact.
      log.error('telegram turn errored', {
        chatId: opts.chatKey.chatId,
        err: errorMessage,
      });
      draftTornDown = true;
      await draft.abort().catch(() => {});
      await opts.checkpointer
        .rollback(rollback.threadId, rollback.checkpointId)
        .catch((e: unknown) =>
          log.error('telegram rollback failed', { err: String(e) }),
        );
      // Raw sendMessage, not the send path: the notice fires when things are
      // already broken, so it must not route through rendering that could be
      // broken too. Skipped on abort — that cancellation is the caller's own.
      if (opts.errorNotice && !opts.signal?.aborted) {
        await opts.client
          .sendMessage(
            { chatId: opts.chatKey.chatId, text: opts.errorNotice },
            opts.signal,
          )
          .catch((e: unknown) =>
            log.error('telegram error notice failed', { err: String(e) }),
          );
      }

      return;
    }

    // 8. finalize + commit + send.
    draftTornDown = true;
    await draft.finalize().catch(() => {});
    // A turn that ends on a tool call leaves the 🔧 frame standing: finalize()
    // stops the animation, it does not blank what it last wrote. Rewrite the
    // status-free text once, directly — the streamer is stopped by now, and its
    // throttle gate would swallow a push this late anyway. Empty `reply` sends
    // empty text, which clears the draft outright; that matters most in the
    // tool-only case below, where no message follows to explain the 🔧.
    // An invisible-only reply is empty in every way that matters, so it collapses
    // to '' here once: it must not reach `sendReply` (see isBlankReply), and it
    // must clear the draft rather than freeze a stale 🔧 frame under itself — a
    // reply of U+200B resets `status`, so that branch alone would not fire.
    const finalText = isBlankReply(reply) ? '' : reply;
    if (status || finalText === '') {
      await opts.client
        .sendMessageDraft(
          {
            chatId: opts.chatKey.chatId,
            draftId: opts.draftId,
            text: finalText,
          },
          opts.signal,
        )
        .catch((e: unknown) =>
          log.warn('telegram draft status clear failed', { err: String(e) }),
        );
    }
    turnCompleted = true;
    if (finalText !== '') {
      await sendReply(
        opts.client,
        opts.chatKey.chatId,
        finalText,
        { rich: opts.rich, log },
        opts.signal,
      );
    } else {
      log.warn('telegram empty reply', { chatId: opts.chatKey.chatId });
      // Same raw-sendMessage discipline as errorNotice: no rendering, skipped on
      // the caller's own abort. Unset → the pre-0.7 warn-only behaviour.
      if (opts.emptyNotice && !opts.signal?.aborted) {
        await opts.client
          .sendMessage(
            { chatId: opts.chatKey.chatId, text: opts.emptyNotice },
            opts.signal,
          )
          .catch((e: unknown) =>
            log.error('telegram empty notice failed', { err: String(e) }),
          );
      }
    }
    await opts.threadStore.touch(opts.chatKey, now());
  } catch (err) {
    // 9. throw mid-stream → rollback (only if snapshotted and not completed).
    log.error('telegram turn failed', { err: String(err) });
    if (rollback && !turnCompleted) {
      draftTornDown = true;
      await draft?.abort().catch(() => {});
      await opts.checkpointer
        .rollback(rollback.threadId, rollback.checkpointId)
        .catch((e: unknown) =>
          log.error('telegram rollback failed', { err: String(e) }),
        );
    }
  } finally {
    // 10. idempotent draft teardown + isolated afterTurn.
    if (!draftTornDown) await draft?.finalize().catch(() => {});
    if (opts.hooks?.afterTurn) {
      try {
        await opts.hooks.afterTurn(ctx);
      } catch (err) {
        log.error('telegram afterTurn hook failed', { err: String(err) });
      }
    }
  }
}
