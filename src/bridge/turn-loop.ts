import {
  createDraftStreamer,
  type DraftConstants,
  type DraftStreamer,
  type FeedBlock,
  type FeedOverrides,
  PLAN_BLOCK,
  renderFeed,
} from '../draft/index.ts';
import type {
  AgentStream,
  BotClient,
  ChatKey,
  Checkpointer,
  Logger,
  PlanItem,
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
  /** Why the turn died, as a bare message on both failure paths (an `Error` from
   *  a mid-stream throw is unwrapped, not stringified). The kit has already
   *  logged it; passed on so a predicate can log its verdict against the cause,
   *  or key policy off it. */
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
  /** Look of the live draft's feed — plan icons, heading, ring size, divider.
   *  The heading defaults to English (`📋 Plan`); override it per locale. */
  feedConstants?: FeedOverrides;
  /** Turn one tool call into the line the user sees in the draft feed. Return a
   *  string to show it, `null` to hide the call entirely (noisy bookkeeping
   *  tools), or `undefined` to defer — the stream's own `label` is used, and
   *  failing that the bare `🔧 \`name\`…`.
   *
   *  This is where app-specific wording lives: only the app knows that
   *  `write_journal` should read `📝 logged: lunch, 620 kcal`. The kit ships no
   *  table of tool names, and the `/deepagents` adapter labels only what is
   *  universal to deepagents itself. */
  formatTool?: (ev: {
    name: string;
    args: unknown;
    label?: string;
  }) => string | null | undefined;
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

  /** Every out-loud line this turn says when it has no reply to send. Raw
   *  sendMessage, never the send path: these fire when things are already broken,
   *  so they must not route through rendering that could be broken too. Skipped
   *  on abort — that cancellation is the caller's own. Sync-throw safe: one call
   *  site sits in the catch handler. */
  const sendNotice = async (
    text: string | undefined,
    failLog: string,
  ): Promise<void> => {
    if (!text || opts.signal?.aborted) return;
    try {
      await opts.client.sendMessage(
        { chatId: opts.chatKey.chatId, text },
        opts.signal,
      );
    } catch (e) {
      log.error(failLog, { err: String(e) });
    }
  };

  /** A kept turn's tool writes stand, so `errorNotice` wording like "sorry, say
   *  that again" is the one thing the user must NOT do — the repeat logs the same
   *  thing a second time. */
  const failureNotice = (rolledBack: boolean): string | undefined =>
    rolledBack ? opts.errorNotice : (opts.keptNotice ?? opts.errorNotice);

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
    //    Wall clock, NOT `opts.now()`: that seam is the caller's domain clock for
    //    the thread store (a message's send time, hours off for a backlogged
    //    one), while the predicate compares this against rows its own tools
    //    stamped in real time.
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

    // 6. stream. The feed is draft-only scaffolding — it is composed onto the
    //    pushed frame but never onto `reply`, so plan and tool narration can
    //    animate live without ever reaching the persisted message.
    //
    //    Append-only, and nothing is ever removed: the pre-0.9 code cleared the
    //    tool line the moment tokens resumed, which is an edit to the middle of
    //    the draft, and the client repaints every character of a draft whose
    //    middle changed. Letting the lines stand costs nothing and repaints less.
    let reply = '';
    const blocks: FeedBlock[] = [];
    let plan: PlanItem[] = [];
    let errorMessage: string | undefined;
    const pushFrame = () =>
      draft?.push(renderFeed(blocks, plan, reply, opts.feedConstants));
    for await (const ev of opts.agentStream(
      { messages: [{ role: 'user', content: opts.userText }] },
      { threadId, signal: opts.signal, configurable: opts.configurable },
    )) {
      if (ev.type === 'token') {
        reply += ev.text;
        pushFrame();
      } else if (ev.type === 'tool_start') {
        // Three-way precedence, and `null` must not collapse into "no opinion":
        // `??` would read a formatter's explicit "hide this" as a miss and fall
        // through to the label, showing the very line it asked to suppress.
        const custom = opts.formatTool?.({
          name: ev.name,
          args: ev.args,
          label: ev.label,
        });
        const line =
          custom === undefined ? (ev.label ?? `🔧 \`${ev.name}\`…`) : custom;
        if (line !== null) {
          blocks.push(line);
          pushFrame();
        }
      } else if (ev.type === 'plan') {
        plan = ev.items;
        // First plan anchors its block; later ones update it in place. Pushing a
        // second anchor would print the plan twice.
        if (!blocks.includes(PLAN_BLOCK)) blocks.push(PLAN_BLOCK);
        pushFrame();
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
      await sendNotice(
        failureNotice(rolledBack),
        'telegram error notice failed',
      );

      return;
    }

    // 8. finalize + commit + send.
    draftTornDown = true;
    await draft.finalize().catch(() => {});
    // No draft rewrite here any more, and both halves of the old one are now
    // settled by watching a real chat (2026-08-01) rather than reasoned about:
    //
    //  - A normal message wipes every live draft in the chat the instant it
    //    lands, so the send below clears the feed on its own. The rewrite this
    //    replaced was one HTTP call whose only effect was to beat that by
    //    milliseconds.
    //  - Empty draft text does NOT clear the draft and does NOT render a
    //    "Thinking…" placeholder — it renders an EMPTY bubble. So on the
    //    empty-reply path, blanking the draft would swap a feed that at least
    //    shows what the turn did for a blank box. The feed stands instead, and
    //    `emptyNotice` (a real message) wipes it; unset, it expires in ~30s.
    const finalText = isBlankText(reply) ? '' : reply;
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
      // Unset → the pre-0.7 warn-only behaviour.
      await sendNotice(opts.emptyNotice, 'telegram empty notice failed');
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
      if (!rolledBack)
        await sendNotice(failureNotice(false), 'telegram error notice failed');
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
