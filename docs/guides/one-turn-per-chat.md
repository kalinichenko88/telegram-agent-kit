# One turn at a time per chat

**Turns on the same chat must not overlap.** `runTelegramTurn` holds no state between
turns, so nothing inside it serializes them — that is `createTurnQueue`'s job, and
it is the supported way to drive turns:

```ts
import { createTurnQueue, runTelegramTurn } from 'telegram-agent-kit';

const queue = createTurnQueue();   // once, at startup

// per incoming message
await queue(chatKey, () => runTelegramTurn({ chatKey, userText, /* … */ }));
```

Two messages landing back to back start two turns against the same thread, and all
three of a turn's stateful steps then corrupt each other: the second turn's
`checkpointer.snapshot` runs on top of the first one's half-finished state, so its
rollback target rewinds into someone else's turn; both turns animate the chat's single
live draft and overwrite each other's frames; and a rollback in either erases work the
other did. Wrap the whole turn, not just the stream — all three steps have to be inside.

Keyed by the whole `ChatKey`, so two bots sharing one chat id never wait on each other.
A rejecting task doesn't wedge the turns queued behind it, and each caller still gets
its own task's result. Drained chains are dropped, so a bot serving many chats doesn't
retain one promise per chat it ever saw.

Two things to avoid. **Await the returned promise** — a rejection from your own callback
reaches nobody else. The queue attaches its own handler to that promise, so Node reports
no unhandled rejection: a rejection you ignore is lost without a trace. And **don't
call the queue for the same key from inside a queued task** (a hook starting a follow-up
turn for its own chat): it waits on a tail that can't settle until the task waiting on it
returns. Both are inherent to a mutex, not specific to this one.

A queue instance is per-process; a bot on several instances needs a shared lock, which is
the same decision its `ThreadStore` already forces. And a new message always *waits* for
the running turn — it never supersedes it. Superseding means aborting mid-flight, and an
aborted turn is rolled back without the `shouldRollback` veto, erasing the thread's
record of tool writes that already landed (the writes themselves stay).
