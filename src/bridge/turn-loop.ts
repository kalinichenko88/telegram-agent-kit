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
import { isBlankText, sendReply } from './send.ts';

export type TurnContext = { chatKey: ChatKey; userText: string };

/** What a `shouldRollback` predicate gets to decide on. `TurnContext` alone
 *  cannot answer "may this turn be erased?" — the question is about what the
 *  turn DID, which is looked up per thread and per time window. */
export type RollbackContext = TurnContext & {
  /** The thread the turn ran on — the same id the `AgentStream` received, so
   *  whatever the tools wrote under it can be looked up by the same key. */
  threadId: string;
  /** `Date.now()` at the moment the turn resolved its thread, pinned before the
   *  stream started. The lower bound of "writes this turn made": no tool of this
   *  turn can have run earlier. Wall clock on purpose — NOT the injectable
   *  `opts.now`, which is the caller's domain clock for the thread store and may
   *  deliberately run hours off (a message's send time rather than now). */
  startedAt: number;
  /** Why the turn died — the `error` event's message, or `String(err)` for a
   *  mid-stream throw. The kit has already logged it; passed on so a predicate
   *  can log its verdict against the cause, or key policy off it. */
  error: string;
};

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
    /** Veto over the rollback of a FAILED turn: return `false` to leave the turn
     *  standing in the thread's history. Unset → the rollback is unconditional,
     *  exactly as it was before 0.8.0.
     *
     *  It lives in `hooks` with the rest of the caller's callbacks rather than at
     *  the top level next to the notices: `preStream` already steers the flow
     *  from this bag (`{ skip: true }` ends the turn before any snapshot), so
     *  "hooks are void-only side effects" was never the rule that kept it out.
     *
     *  NOT consulted when the turn was cancelled via `signal`: a cancelled turn
     *  is always rolled back. Mind that if you use `signal` as a turn BUDGET
     *  rather than for shutdown, since a timed-out turn that already wrote is
     *  then erased anyway — the case this predicate exists for.
     *
     *  Awaited unbounded, like every other hook here, and it runs after the
     *  draft is torn down but before the notice: a predicate that hangs parks
     *  the turn with a dead draft and no `afterTurn`. Bound your own I/O. */
    shouldRollback?: (ctx: RollbackContext) => boolean | Promise<boolean>;
  };
  draftConstants?: Partial<DraftConstants>;
  configurable?: Record<string, unknown>;
  /** Plain-text line sent to the chat when the stream errors out (model chain
   *  exhausted, graph threw). Without it the turn returns silently and the user
   *  sees only a draft that stops moving — indistinguishable from being ignored.
   *  Sent for a failed turn that WAS rolled back; see `keptNotice` for the one
   *  that was not. */
  errorNotice?: string;
  /** Plain-text line sent instead of `errorNotice` when a failed turn was NOT
   *  rolled back (a `hooks.shouldRollback` veto, or a rollback that itself
   *  threw). Third line for the same reason `emptyNotice` is the second one: the
   *  turn's tool writes stand, so "try again" is actively harmful advice — the
   *  repeat writes the same thing twice. Unset → falls back to `errorNotice`,
   *  so the user still hears something. */
  keptNotice?: string;
  /** Plain-text line sent when the turn COMPLETES with nothing to say — it ended
   *  on a tool call, or the model answered with invisible characters only.
   *  Deliberately a separate line from `errorNotice`: this turn was not rolled
   *  back, so whatever its tools wrote stands, and words like "it broke" invite a
   *  re-send that logs the same thing twice. */
  emptyNotice?: string;
};

const NOOP_LOG: Logger = { warn: () => {}, error: () => {} };

/** Where a failed turn would be rewound to, plus the instant it started — the
 *  window `shouldRollback` needs. Set only once the snapshot exists. */
type RollbackTarget = {
  threadId: string;
  checkpointId: string | null;
  startedAt: number;
};

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

  let rollback: RollbackTarget | null = null;
  let turnCompleted = false;
  let draft: DraftStreamer | null = null;
  let draftTornDown = false;

  /** Rewinds the thread to the pre-turn snapshot unless the caller vetoes it.
   *  Returns whether the thread was actually rewound — what the user should be
   *  told depends on it.
   *
   *  Rollback undoes MEMORY, never CONSEQUENCES. Tools that completed before the
   *  turn died have already written to the outside world — notes, journal rows,
   *  tables — and no checkpoint rewind touches those. Erasing such a turn leaves
   *  the agent not remembering writes it really made, so the next turn reads its
   *  own output as foreign and "repairs" it. Which tools write is knowledge the
   *  app owns entirely; the kit only asks. */
  const rollbackUnlessVetoed = async (
    target: RollbackTarget,
    error: string,
  ): Promise<boolean> => {
    // Cancellation stays unconditional: the caller asked for this turn to go
    // away, which is a different question from "is it safe to forget it".
    if (opts.hooks?.shouldRollback && !opts.signal?.aborted) {
      let verdict: boolean;
      try {
        verdict = await opts.hooks.shouldRollback({
          ...ctx,
          threadId: target.threadId,
          startedAt: target.startedAt,
          error,
        });
      } catch (e) {
        // A throwing predicate answers nothing, and the two wrong answers are
        // not symmetric: a turn wrongly KEPT is one stale entry in the thread —
        // visible, and fixable by hand — while a turn wrongly ROLLED BACK
        // silently desyncs memory from writes that really happened, which is the
        // exact damage this predicate exists to prevent. Only an app whose tools
        // write installs one at all, so "unknown" resolves to "it probably
        // wrote": keep the turn.
        log.error('telegram shouldRollback hook failed', { err: String(e) });
        verdict = false;
      }
      if (!verdict) {
        log.warn('telegram rollback skipped', {
          chatId: opts.chatKey.chatId,
          threadId: target.threadId,
        });
        return false;
      }
    }
    // try/catch, not `.catch()`: a caller's `rollback` may be a plain method
    // that validates before returning a promise, and a SYNCHRONOUS throw walks
    // straight past `.catch`. From the step-9 handler that lands outside every
    // try in this function — i.e. out of `runTelegramTurn`, which is the one
    // thing this function promises cannot happen.
    try {
      await opts.checkpointer.rollback(target.threadId, target.checkpointId);
      return true;
    } catch (e) {
      // Reported as not-rolled-back on purpose: the thread most likely still
      // carries the turn, and the cautious notice is the honest one here.
      log.error('telegram rollback failed', { err: String(e) });
      return false;
    }
  };

  /** The plain-text line a FAILED turn says out loud. Raw sendMessage, never the
   *  send path: it fires when things are already broken, so it must not route
   *  through rendering that could be broken too. Skipped on abort — that
   *  cancellation is the caller's own. Sync-throw safe for the same reason the
   *  rollback above is: one call site sits in the catch handler. */
  const sendFailureNotice = async (rolledBack: boolean): Promise<void> => {
    // A kept turn's tool writes stand, so `errorNotice` wording like "sorry, say
    // that again" is the one thing the user must NOT do — the repeat logs the
    // same thing a second time.
    const text = rolledBack
      ? opts.errorNotice
      : (opts.keptNotice ?? opts.errorNotice);
    if (!text || opts.signal?.aborted) return;
    try {
      await opts.client.sendMessage(
        { chatId: opts.chatKey.chatId, text },
        opts.signal,
      );
    } catch (e) {
      log.error('telegram error notice failed', { err: String(e) });
    }
  };

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

    // 3. resolve thread. `startedAt` is pinned here, ahead of the stream: no
    //    tool of this turn can have run before it, so it is a sound lower bound
    //    for a `shouldRollback` predicate asking "did this turn write anything?".
    //
    //    Wall clock, deliberately NOT `opts.now()`. That seam is the caller's
    //    DOMAIN clock for the thread store — a consuming app feeds it the
    //    Telegram message's send time so a backlogged message is filed into the
    //    day it was sent, which can be hours off real time. The predicate
    //    compares this against timestamps its own tools wrote, so it needs the
    //    same clock those rows carry. Same split the draft engine already makes:
    //    its timing has its own clock, independent of this one.
    const startedAt = Date.now();
    const threadId = await opts.threadStore.resolve(opts.chatKey, now());

    // 4. snapshot — set the rollback target only now.
    const checkpointId = await opts.checkpointer.snapshot(threadId);
    rollback = { threadId, checkpointId, startedAt };

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
      const rolledBack = await rollbackUnlessVetoed(rollback, errorMessage);
      await sendFailureNotice(rolledBack);

      return;
    }

    // 8. finalize + commit + send.
    draftTornDown = true;
    await draft.finalize().catch(() => {});
    // A turn that ends on a tool call leaves the 🔧 frame standing: finalize()
    // stops the animation, it does not blank what it last wrote. Rewrite the
    // status-free text once, directly — the streamer is stopped by now, and its
    // throttle gate would swallow a push this late anyway.
    //
    // What empty draft text DOES is not verified against the live Bot API: this
    // file has claimed it clears the draft outright, while machine-spirit's
    // channel notes record the opposite (an empty draft renders a "Thinking…"
    // placeholder), which is why that app never sends empty text on abort. Until
    // someone watches a real chat, the condition stays exactly as narrow as it
    // was before 0.7.0 — `status` only. An invisible-only reply resets `status`,
    // so such a turn keeps its stale 🔧 frame; cosmetic, pre-existing, and
    // strictly better than a fresh "Thinking…" rendered directly above the
    // `emptyNotice` that says the turn is over (it would also refresh the ~30s
    // draft expiry).
    const finalText = isBlankText(reply) ? '' : reply;
    if (status) {
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
    //    Same veto as the `error` event: a turn that died by throwing had the
    //    same tools running, so exempting this path would leave the hole open on
    //    the other side.
    log.error('telegram turn failed', { err: String(err) });
    if (rollback && !turnCompleted) {
      draftTornDown = true;
      await draft?.abort().catch(() => {});
      // `.message`, not `String(err)`: the `error`-event path hands the predicate
      // a bare message, and one failure arriving as `Recursion limit…` on one
      // path and `Error: Recursion limit…` on the other silently flips any
      // predicate that reads the text.
      const message = err instanceof Error ? err.message : String(err);
      const rolledBack = await rollbackUnlessVetoed(rollback, message);
      // Only a KEPT turn speaks here. A rolled-back one stays silent exactly as
      // it did before 0.8.0 — but silence used to mean one thing, and letting it
      // now also mean "your writes stand" is what invites the duplicate re-send.
      if (!rolledBack) await sendFailureNotice(false);
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
