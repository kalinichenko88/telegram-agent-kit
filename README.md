# telegram-agent-kit

> Wire LLM agents to Telegram: render Markdown, stream replies into a live native draft, and drive a snapshot/rollback turn-loop — over thin injected interfaces, with **zero runtime dependencies** in the core.

[![npm](https://img.shields.io/npm/v/telegram-agent-kit.svg)](https://www.npmjs.com/package/telegram-agent-kit)
[![license](https://img.shields.io/npm/l/telegram-agent-kit.svg)](./LICENSE)
[![types](https://img.shields.io/npm/types/telegram-agent-kit.svg)](https://www.typescriptlang.org/)

ESM-only. Runs on **Node 18+, Bun, Deno, and the browser** (the formatting core).

---

## Why this exists

Connecting an LLM agent to a Telegram bot looks simple until you hit the edges:

- LLMs emit arbitrary Markdown — Telegram speaks a small, strict HTML subset. A
  single unclosed tag makes the Bot API reject the whole message.
- Token streaming into a *live draft* means you render **partial** Markdown many
  times a second, where marks and fences are routinely mid-token.
- A failed turn must roll back cleanly so the conversation thread isn't corrupted.

`telegram-agent-kit` solves these once. Notably, it's the only JS package that
renders Markdown to **Telegram-HTML** with **totality** (never throws on arbitrary
LLM output) *and* a **streaming/partial** mode (auto-closes unclosed marks and
fences, so a live draft never flashes broken markup).

It is **runtime-agnostic**: you supply all I/O through small injected interfaces,
and the kit owns the orchestration. No HTTP client, no framework, no globals.

## Features

- **Markdown → Telegram-HTML** that never throws, with a `partial` mode for live drafts.
- **Live draft streaming** — a throttle / keepalive / typing-heartbeat / drain state
  machine that animates one native Telegram draft from a growing string.
- **Turn-loop orchestration** — `snapshot → stream → animate → finalize → reply`,
  with rollback on error and a guarantee it never throws out.
- **Resilient send path** — automatic chunking, surrogate-safe splitting, and
  deterministic `400` fallbacks (rich → HTML → plain text; photo → text).
- **Optional deepagents adapter** on a separate subpath, so the core never pulls in
  langchain.

## Installation

```sh
npm install telegram-agent-kit
```

The optional `telegram-agent-kit/deepagents` subpath needs its peers — install them
only if you use it:

```sh
npm install @langchain/core deepagents
```

## Quick start

Implement a thin `BotClient` over the Bot API, then drive one turn per incoming
message. The example uses the deepagents adapter, but any `AgentStream` works.

```ts
import { runTelegramTurn, TelegramApiError, type BotClient } from 'telegram-agent-kit';
import { toAgentStream } from 'telegram-agent-kit/deepagents';

// 1. Raw Bot API primitives — one HTTP call each. Throw TelegramApiError on a
//    Bot API error so the kit's deterministic-400 fallbacks can fire.
const client: BotClient = {
  sendMessage:        (p, signal) => call('sendMessage',        { chat_id: p.chatId, text: p.text, parse_mode: p.parseMode }, signal),
  sendRichMessage:    (p, signal) => call('sendMessage',        { chat_id: p.chatId, text: p.markdown },                       signal),
  sendPhoto:          (p, signal) => call('sendPhoto',          { chat_id: p.chatId, photo: p.url, caption: p.caption, parse_mode: p.parseMode }, signal),
  sendChatAction:     (p, signal) => call('sendChatAction',     { chat_id: p.chatId, action: p.action ?? 'typing' },          signal),
  sendMessageDraft:   (p, signal) => call('sendMessageDraft',   { chat_id: p.chatId, draft_id: p.draftId, text: p.text },     signal),
  sendRichMessageDraft:(p, signal) => call('sendRichMessageDraft',{ chat_id: p.chatId, draft_id: p.draftId, text: p.markdown },signal),
};

// 2. Drive one turn.
await runTelegramTurn({
  chatKey: { chatId, agentId: 'main' },
  userText,
  draftId: updateId,        // non-zero, unique per turn — reused for every draft write
  rich: true,
  client,
  agentStream: toAgentStream(agent),   // your deepagents agent
  checkpointer: {
    snapshot: (threadId)     => saver.snapshotId(threadId),
    rollback: (threadId, id) => saver.rollbackThread(threadId, id),
  },
  threadStore: {
    resolve: (key)      => threads.resolve(key.chatId, key.agentId),
    touch:   (key, now) => threads.touch(key.chatId, key.agentId, now),
  },
  log: console,
});

// Thin transport helper.
async function call(method: string, body: unknown, signal?: AbortSignal) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new TelegramApiError(res.status, j.description);
  }
}
```

> **Note:** `sendRichMessage` / `sendRichMessageDraft` map to your bot's rich-text
> transport. If your bot has no rich endpoint, point them at plain `sendMessage`
> and set `rich: false` — the kit then renders via HTML only.

## How it works

The kit is three layers plus one optional adapter. The dependency direction is
strictly **Bridge → Draft → Formatting**; lower layers never import higher ones,
and the core never imports the adapter.

```
┌─────────────────────────────────────────────────────────────┐
│  /deepagents  (optional subpath)                            │
│  toAgentStream · streamAgent  →  AgentStream                │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│  Bridge       runTelegramTurn · sendReply · sendText        │
│               + the four interfaces you implement           │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│  Draft        createDraftStreamer (throttle/keepalive/drain)│
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│  Format       mdToTelegramHtml · chunk* · rich helpers      │
│               pure, zero deps, browser-safe                 │
└─────────────────────────────────────────────────────────────┘
```

**Transport vs. orchestration.** You provide *raw* Bot API primitives — one HTTP
call each, no chunking, rendering, or fallback. The kit owns all orchestration over
them: HTML rendering, chunking, the rich → classic and photo → text `400` fallbacks,
and the trailing-cover photo flow.

## The four interfaces

You implement these; the kit drives them.

| Interface      | Shape                                                                 | Role |
| -------------- | --------------------------------------------------------------------- | ---- |
| `BotClient`    | `sendMessage`, `sendRichMessage`, `sendPhoto`, `sendChatAction`, `sendMessageDraft`, `sendRichMessageDraft` | Raw transport. Each throws `TelegramApiError` on a Bot API error. |
| `AgentStream`  | `(input, { threadId, signal, configurable }) => AsyncIterable<RenderEvent>` | Your agent. `threadId` **must** reach it so the checkpointer writes to the snapshotted thread. `configurable` is an optional pass-through bag forwarded verbatim from `runTelegramTurn`'s `configurable` option. |
| `Checkpointer` | `{ snapshot(threadId), rollback(threadId, id) }`                       | Per-thread snapshot/rollback for clean recovery on a failed turn. |
| `ThreadStore`  | `{ resolve(chatKey, now), touch(chatKey, now) }`                      | Maps `{ chatId, agentId }` to a thread id (so two bots over one chat id don't collide). |

A `RenderEvent` is one of `token`, `tool_start`, `tool_end`, or `error`. The kit
appends `token` text to the live draft and treats an `error` event as a rollback.

## API reference

### Core entry — `telegram-agent-kit`

**Formatting** (pure, zero deps)

- `mdToTelegramHtml(md, opts?)` — Markdown → Telegram-HTML. Never throws. `opts.partial`
  auto-closes unclosed marks/fences for live drafts.
- `chunkText(text)` / `safeSlice(text, max)` / `chunkRich(md)` — surrogate-safe splitting
  (classic limit 4096, rich limit 32768).
- `repairRichTables(md)` · `neutralizeRichMedia(md)` · `extractTrailingCover(reply)` — rich helpers.

**Draft engine**

- `createDraftStreamer(deps)` → `{ start(), push(fullText), finalize(), abort() }`.
- `DEFAULT_DRAFT_CONSTANTS` / `DraftConstants` — overridable tunables (throttle, keepalive,
  typing heartbeat, preview cap, drain, …).

**Bridge**

- `runTelegramTurn(opts)` — orchestrate one turn. Never throws out; every failure is caught and logged.
  Accepts an optional `configurable` bag forwarded to your `AgentStream` as `context.configurable`,
  for passing per-turn data (e.g. `pendingImages`) to the agent without widening the core input type.
- `sendReply(client, chatId, reply, opts, signal?)` / `sendText(...)` — the send path on its own.
- Types: `BotClient`, `AgentStream`, `Checkpointer`, `ThreadStore`, `RenderEvent`, `ChatKey`, `Logger`.

**Errors**

- `TelegramApiError` — throw this from `BotClient` primitives (carries `error_code`).
- `isBadRequest(err)` — true only for a deterministic `400` (rejected, safe to retry on a degraded path).

### Optional entry — `telegram-agent-kit/deepagents`

- `toAgentStream(agent)` → `AgentStream` — adapts a deepagents/langgraph agent to the kit's contract.
  The `context.configurable` bag is merged into the LangGraph `RunnableConfig`, but the reserved keys
  `thread_id`, `thread_ts`, `checkpoint_id`, `checkpoint_ns`, `checkpoint_map`, and `run_id` — plus any
  `__pregel_*` LangGraph internal-execution key — are stripped so the kit retains full control over
  checkpoint routing and execution.
- `streamAgent(agent, input, config, signal?)` — lower-level event stream if you need direct control.

> `@langchain/core` and `deepagents` are **type-only, optional** peers. The built
> `/deepagents` bundle contains no runtime import of either, so the core stays
> dependency-free.

## Design guarantees

These are intentional and enforced by tests:

- **`mdToTelegramHtml` is total** — it never throws on any LLM output. The send path
  also wraps it and falls back to plain text as defence-in-depth.
- **Deterministic `400` fallbacks** keyed off `isBadRequest`: rich → classic HTML →
  plain text, and photo → text. Any non-`400` error always propagates.
- **`runTelegramTurn` never throws out** — snapshot happens only after a turn isn't
  skipped, rollback fires only on a real failure, and draft teardown is idempotent.
- **Surrogate-safe splitting** — chunking never severs a UTF-16 surrogate pair.

## Development

```sh
npm run build       # tsup → dist/ (ESM + .d.ts) for both entry points
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run lint        # biome check .
npm run format      # biome format --write .
```

Run a single test:

```sh
npx vitest run test/format/md-to-html.test.ts     # one file
npx vitest run -t "renders nested bold"           # by name
```

> Build before testing if you touch `/deepagents`: one test greps the built bundle
> to prove it carries no runtime import of the optional peers (it skips when `dist/`
> is absent). CI runs `build` before `test` for this reason.

## Contributing

Issues and pull requests are welcome. Before opening a PR, please run
`npm run lint`, `npm run typecheck`, and `npm test` — and `npm run build` if your
change touches the `/deepagents` entry. See [CHANGELOG.md](./CHANGELOG.md) for the
project history.

## License

[MIT](./LICENSE) © Ivan Kalinichenko
