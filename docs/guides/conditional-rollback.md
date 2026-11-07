# Conditional rollback

Rolling a failed turn back undoes **memory, never consequences**. Tools that finished
before the turn died have already written to the outside world — notes, journal rows,
tables — and no checkpoint rewind touches those. Erase the turn and the agent no longer
remembers writes it really made, so the next turn reads its own output as foreign and
starts "repairing" it.

Which of your tools write is knowledge the kit cannot have, so it asks:

```ts
hooks: {
  // false → keep the failed turn in the thread; true → rewind, as always.
  shouldRollback: async ({ threadId, startedAt, error, chatKey, userText }) =>
    !(await audit.hadWritesSince(threadId, startedAt)),
},
keptNotice: 'Ход упал на середине. Часть записей уже сделана — не повторяй, проверь.',
```

`threadId` is the same id your `AgentStream` got. `startedAt` is `Date.now()` pinned
before the stream, so no tool of this turn can predate it — deliberately the **wall
clock, not the injectable `opts.now`**, which is your domain clock for the thread store
and may legitimately run hours off real time (feeding it a message's send time so a
backlogged message is filed into the day it was sent is a real pattern). Compare
`startedAt` against timestamps written by that same wall clock. Rules:

- **No predicate → unconditional rollback**, byte for byte the pre-0.8.0 behaviour.
- **Cancellation (`signal`) is exempt** — a cancelled turn is always rolled back, the
  predicate isn't consulted. Mind this if you use `signal` as a turn *budget* rather than
  for shutdown: a timed-out turn that already wrote gets erased anyway, which is the very
  case the predicate exists for. Cancel that way and you want the veto on every path —
  open an issue rather than working around it.
- **A predicate that throws keeps the turn** and never breaks the loop. The two wrong
  answers aren't symmetric: a turn wrongly kept is one stale thread entry you can see and
  fix, a turn wrongly rolled back silently desyncs memory from real writes.
- **It is awaited unbounded**, like every other hook here, and runs after the draft is
  torn down but before the notice — a predicate that hangs parks the turn with a dead
  draft and no `afterTurn`. Bound your own I/O.
- Guards both failure paths — the `error` event *and* a mid-stream throw. `error` reaches
  the predicate as a bare message on both (an `Error` is unwrapped, not stringified).
- `keptNotice` replaces `errorNotice` for a kept turn (and falls back to it when unset),
  because "sorry, try again" is the one thing the user must not do when the writes stand.
  On the mid-stream-throw path only a *kept* turn speaks: a rolled-back one stays silent
  there, exactly as it did before 0.8.0.

**What a kept turn leaves in the thread.** Measured against `@langchain/langgraph` 1.4.8
with a `MemorySaver`, killing a model → tool → model loop with `GraphRecursionError` (the
failure from the incident this feature comes from): the thread keeps the human message,
every `AIMessage` with its `tool_calls`, and a `ToolMessage` for every tool that actually
completed — one checkpoint per super-step, the first written *before* the model ran. So
the kept turn is an honest record of what happened, not a fragment: the agent's memory
now matches the rows its tools wrote. Two caveats. The graph is left mid-run
(`getState().next` points at the node that was about to run, with a pending task), and
the turn has no final assistant message — the next user message appends to that state and
runs from there. Judge for yourself whether your graph resumes cleanly from it; if it
doesn't, that's an argument for rolling back and reconciling the writes by hand.
