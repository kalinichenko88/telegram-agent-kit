import type { ChatKey } from './interfaces.ts';

/** Runs `task` after every task already queued for `key`, and returns whatever
 *  `task` returns. Tasks under different keys never wait on each other. */
export type TurnQueue = <T>(key: ChatKey, task: () => Promise<T>) => Promise<T>;

/** Serializes turns per chat. Two messages landing back to back start two
 *  `runTelegramTurn` calls against the SAME thread, and nothing inside the turn
 *  loop serializes them — the kit holds no state between turns by design. Left
 *  overlapping, all three of a turn's stateful steps corrupt each other:
 *
 *   - `checkpointer.snapshot` for the second turn runs on top of the first one's
 *     half-finished state, so its rollback target rewinds to the middle of
 *     someone else's turn.
 *   - A chat has only ONE live draft (measured, see the draft layer), so both
 *     turns animate the same bubble and overwrite each other's frames.
 *   - A rollback in either turn erases work the other one did.
 *
 *  So wrap the turn, not just the stream — all three steps have to be inside:
 *
 *      const queue = createTurnQueue();
 *      await queue(chatKey, () => runTelegramTurn({ ... }));
 *
 *  Keyed by the whole `ChatKey`, not `chatId`: two bots sharing one chat id run
 *  on different threads and have no reason to wait on each other, exactly as in
 *  the `ThreadStore`.
 *
 *  Four caveats, with their reasoning, live in the README: the queue is
 *  per-process, the returned promise must be awaited, a queued task must not
 *  call the queue for its own key, and a new message waits for the running turn
 *  rather than superseding it. */
export function createTurnQueue(): TurnQueue {
  /** Tail of each key's chain. Every stored promise is settled-either-way (see
   *  below), so it is safe to chain onto and can only ever resolve. */
  const chains = new Map<string, Promise<unknown>>();

  return <T>(key: ChatKey, task: () => Promise<T>): Promise<T> => {
    // `chatId` is a number, so it can never contain the separator — the first
    // `:` always splits the two parts, whatever an `agentId` holds.
    const k = `${key.chatId}:${key.agentId}`;

    const result = (chains.get(k) ?? Promise.resolve()).then(task);
    // The stored tail swallows the outcome. A rejecting task must not wedge
    // every turn queued behind it: chaining the raw `result` would skip their
    // `task` entirely and reject them with a failure from someone else's turn.
    // The caller still gets `result` itself, rejection and all.
    const settled = result.catch(() => {});
    chains.set(k, settled);
    // Drop the entry once this chain drains, or a bot serving many chats retains
    // one promise per chat it ever saw. Guarded on still being the tail: a task
    // queued in the meantime owns the slot now.
    settled.then(() => {
      if (chains.get(k) === settled) chains.delete(k);
    });

    return result;
  };
}
