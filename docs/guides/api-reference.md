# API reference

## Core entry — `telegram-agent-kit`

**Formatting** (pure, zero deps)

- `mdToTelegramHtml(md, opts?)` — Markdown → Telegram-HTML. Never throws. `opts.partial`
  auto-closes unclosed marks/fences for live drafts.
- `chunkText(text)` / `safeSlice(text, max)` / `chunkRich(md)` — surrogate-safe splitting
  (classic limit 4096, rich limit 32768).
- `repairRichTables(md)` · `neutralizeRichMedia(md)` · `extractTrailingCover(reply)` — rich helpers.
- `needsRich(md)` — does this text need the rich renderer (today: does it contain a GFM
  table, outside code)? The gate behind `rich: true`; everything else goes classic.

**Draft engine**

- `createDraftStreamer(deps)` → `{ start(), push(fullText), finalize(), abort() }`.
- `DEFAULT_DRAFT_CONSTANTS` / `DraftConstants` — overridable tunables (throttle, keepalive,
  typing heartbeat, preview cap, drain, …).
- `renderFeed(blocks, plan, reply, overrides?)` — compose one draft frame (see
  [The draft feed](draft-feed.md)). `PLAN_BLOCK` marks the plan's
  slot in `blocks`; `strikeThrough(text)` is the U+0336 overlay used on done steps, applied
  per grapheme so emoji sequences survive. `DEFAULT_FEED_CONSTANTS` / `FeedConstants` /
  `FeedOverrides` are the knobs.

**Bridge**

- `runTelegramTurn(opts)` — orchestrate one turn. Never throws out; every failure is caught and logged.
  Accepts an optional `configurable` bag forwarded to your `AgentStream` as `context.configurable`,
  for passing per-turn data (e.g. `pendingImages`) to the agent without widening the core input type.
  Pass `errorNotice` (plain text, your language) to have a failed turn say so in the chat —
  omit it and the user just sees the draft stop, which reads as being ignored. Pass
  `emptyNotice` for the same reason on a turn that completed with no reply text, and
  `keptNotice` for a failed turn your `hooks.shouldRollback` kept (see
  [Conditional rollback](conditional-rollback.md)). `feedConstants` and `formatTool` shape the
  draft feed (see [The draft feed](draft-feed.md)).
- `createTurnQueue()` → `(chatKey, task) => Promise` — serializes turns per `ChatKey`. Turns on
  one chat must not overlap; wrap every `runTelegramTurn` call in it (see
  [One turn at a time per chat](one-turn-per-chat.md)).
- `sendReply(client, chatId, reply, opts, signal?)` / `sendText(...)` — the send path on its own.
  `opts` is `{ rich: boolean, log: Logger }`, with the same `rich` semantics as in the [quick start](../../README.md#quick-start).
- Types: `BotClient`, `AgentStream`, `Checkpointer`, `ThreadStore`, `RenderEvent`, `PlanItem`,
  `ChatKey`, `Logger`, `TurnContext`, `RollbackContext`, `TurnQueue`.

**Errors**

- `TelegramApiError` — throw this from `BotClient` primitives (carries `error_code`, `description`
  and the Bot API's `parameters`, whose `retry_after` the draft streamer honours on a `429`).
- `isBadRequest(err)` — true only for a deterministic `400` (rejected, safe to retry on a degraded path).
- `isRateLimited(err)` — true for a `429` (throttled, not rejected — wait `parameters.retry_after`).

## Optional entry — `telegram-agent-kit/deepagents`

- `toAgentStream(agent)` → `AgentStream` — adapts a deepagents/langgraph agent to the kit's contract.
  The `context.configurable` bag is merged into the LangGraph `RunnableConfig`, but the reserved keys
  `thread_id`, `thread_ts`, `checkpoint_id`, `checkpoint_ns`, `checkpoint_map`, and `run_id` — plus any
  `__pregel_*` LangGraph internal-execution key — are stripped so the kit retains full control over
  checkpoint routing and execution.
- Turns `write_todos` (langchain's todo-list middleware) into `plan` events and labels a skill load (a `read_file`
  on `/skills/<name>/SKILL.md`, how deepagents load skills via progressive disclosure) as
  `🧠 load_skill(\`name\`)…`. This is the **only** place in the kit that knows any tool name; the core
  turn loop knows none.
- `streamAgent(agent, input, config, signal?)` — lower-level event stream if you need direct control.
  Yields tokens from the **root** agent only: a delegated agent (a `subagents` entry, or the built-in
  `task` tool) runs its own model node and LangChain replays its events into the parent stream, so
  without this its monologue would interleave with the reply. Naming the root agent does not change
  what streams.

> `@langchain/core` and `deepagents` are **type-only, optional** peers. The built
> `/deepagents` bundle contains no runtime import of either, so the core stays
> dependency-free.
