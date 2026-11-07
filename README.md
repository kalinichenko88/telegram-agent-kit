# telegram-agent-kit

> Wire LLM agents to Telegram: render Markdown, stream replies into a live native draft, and drive a snapshot/rollback turn-loop — over thin injected interfaces, with **zero runtime dependencies** in the core.

[![npm](https://img.shields.io/npm/v/telegram-agent-kit.svg)](https://www.npmjs.com/package/telegram-agent-kit)
[![downloads](https://img.shields.io/npm/dm/telegram-agent-kit.svg)](https://www.npmjs.com/package/telegram-agent-kit)
[![ci](https://github.com/kalinichenko88/telegram-agent-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/kalinichenko88/telegram-agent-kit/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/telegram-agent-kit.svg)](https://github.com/kalinichenko88/telegram-agent-kit/blob/main/LICENSE)
[![types](https://img.shields.io/npm/types/telegram-agent-kit.svg)](https://www.typescriptlang.org/)

ESM-only. Runs on **Node 20+, Bun, Deno, and the browser** (the formatting core).

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
  with a vetoable rollback on error and a guarantee it never throws out.
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
import { createTurnQueue, runTelegramTurn, TelegramApiError, type BotClient } from 'telegram-agent-kit';
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

// 2. Drive one turn — inside the queue, so turns on one chat never overlap.
//    Create the queue ONCE at startup, not per message.
const queue = createTurnQueue();

const chatKey = { chatId, agentId: 'main' };

await queue(chatKey, () => runTelegramTurn({
  chatKey,
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
}));

// Thin transport helper. Bound every call with a ceiling of your own: the kit
// awaits a draft write's response because that response is the only thing
// ordering it ahead of the message that replaces it, and only the transport can
// actually cancel a request — the kit's `drainMs` can stop waiting, not sending.
async function call(method: string, body: unknown, signal?: AbortSignal) {
  const ceiling = AbortSignal.timeout(30_000);
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, ceiling]) : ceiling,
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    // Pass `parameters` through: on a 429 the draft streamer backs off by its
    // `retry_after` instead of counting the throttle as a transport failure.
    throw new TelegramApiError(res.status, j.description, j.parameters);
  }
}
```

> **Note:** `sendRichMessage` / `sendRichMessageDraft` map to your bot's rich-text
> transport. If your bot has no rich endpoint, point them at plain `sendMessage`
> and set `rich: false` — the kit then renders via HTML only.

> **Note:** `rich: true` means *rich when it buys something*, not *rich always*.
> Drafts and final messages go out rich only for text that needs the rich
> renderer — today, a GFM table (`needsRich`); everything else is classic HTML, so
> ordinary replies keep the client's normal message font. `rich: false` is still
> the kill-switch: HTML only, always.

## How it works

The kit is three layers plus one optional adapter. The dependency direction is
strictly **Bridge → Draft → Formatting**; lower layers never import higher ones at
runtime, and the core never imports the adapter.

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

## Documentation

The guides live in
[`docs/guides/`](https://github.com/kalinichenko88/telegram-agent-kit/tree/main/docs/guides):

- [The four interfaces](https://github.com/kalinichenko88/telegram-agent-kit/blob/main/docs/guides/interfaces.md)
  — what you implement, the events your agent emits, and the empty turn.
- [One turn at a time per chat](https://github.com/kalinichenko88/telegram-agent-kit/blob/main/docs/guides/one-turn-per-chat.md)
  — `createTurnQueue`, and why two turns on one chat must not overlap.
- [The draft feed](https://github.com/kalinichenko88/telegram-agent-kit/blob/main/docs/guides/draft-feed.md)
  — the plan and the tool progress above the streaming reply.
- [Conditional rollback](https://github.com/kalinichenko88/telegram-agent-kit/blob/main/docs/guides/conditional-rollback.md)
  — keep a failed turn whose tools already wrote.
- [API reference](https://github.com/kalinichenko88/telegram-agent-kit/blob/main/docs/guides/api-reference.md)
  — the main exports of both entry points.
- [Design guarantees](https://github.com/kalinichenko88/telegram-agent-kit/blob/main/docs/guides/design-guarantees.md)
  — what the tests enforce.

[CHANGELOG.md](https://github.com/kalinichenko88/telegram-agent-kit/blob/main/CHANGELOG.md)
holds the history of each release.

## Contributing

Issues and pull requests are welcome. Read
[CONTRIBUTING.md](https://github.com/kalinichenko88/telegram-agent-kit/blob/main/CONTRIBUTING.md)
for the setup, the commands and the check to run before a PR.

## License

[MIT](https://github.com/kalinichenko88/telegram-agent-kit/blob/main/LICENSE) © Ivan Kalinichenko
