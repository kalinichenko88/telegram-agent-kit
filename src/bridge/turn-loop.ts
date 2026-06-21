import {
  createDraftStreamer,
  type DraftConstants,
  type DraftStreamer,
  type DraftStreamerDeps,
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
  makeDraftStreamer?: (deps: DraftStreamerDeps) => DraftStreamer;
  draftConstants?: Partial<DraftConstants>;
};

const NOOP_LOG: Logger = { warn: () => {}, error: () => {} };

export async function runTelegramTurn(
  opts: RunTelegramTurnOpts,
): Promise<void> {
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? NOOP_LOG;
  const makeDraftStreamer = opts.makeDraftStreamer ?? createDraftStreamer;
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
    draft = makeDraftStreamer({
      client: opts.client,
      chatId: opts.chatKey.chatId,
      draftId: opts.draftId,
      rich: opts.rich,
      log,
      constants: opts.draftConstants,
    });
    draft.start();

    // 6. stream.
    let reply = '';
    let errored = false;
    for await (const ev of opts.agentStream(
      { messages: [{ role: 'user', content: opts.userText }] },
      { threadId, signal: opts.signal },
    )) {
      if (ev.type === 'token') {
        reply += ev.text;
        draft.push(reply);
      } else if (ev.type === 'error') errored = true;
    }

    // 7. errored → abort then rollback.
    if (errored) {
      draftTornDown = true;
      await draft.abort().catch(() => {});
      await opts.checkpointer
        .rollback(rollback.threadId, rollback.checkpointId)
        .catch((e: unknown) =>
          log.error('telegram rollback failed', { err: String(e) }),
        );

      return;
    }

    // 8. finalize + commit + send.
    draftTornDown = true;
    await draft.finalize().catch(() => {});
    turnCompleted = true;
    if (reply.trim().length > 0) {
      await sendReply(
        opts.client,
        opts.chatKey.chatId,
        reply,
        { rich: opts.rich, log },
        opts.signal,
      );
    } else {
      log.warn('telegram empty reply', { chatId: opts.chatKey.chatId });
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
