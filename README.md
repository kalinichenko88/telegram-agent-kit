# telegram-agent-kit

Runtime-agnostic toolkit for wiring LLM agents to Telegram: render markdown
to Telegram, animate an agent's token stream into a **live native draft**,
and drive a **snapshot/rollback turn-loop** — over thin injected interfaces,
with **zero runtime dependencies** in the core.

It fills a real gap in the npm ecosystem: there is no other JS package that
renders markdown to **Telegram-HTML** with *totality* (never throws on
arbitrary LLM output) **and** a *streaming/partial* mode (auto-closes
unclosed marks/fences so a live draft never shows broken markup).

ESM-only. Runs on Node 18+, Bun, Deno, and the browser (core).

## Install

```sh
npm install telegram-agent-kit
```

The `telegram-agent-kit/deepagents` subpath additionally needs the optional
peers (only if you use it): `npm install @langchain/core deepagents`.

## What's inside

- **L1 — formatting (pure):** `mdToTelegramHtml` (totality + `partial`
  mode), `chunkText` / `safeSlice` / `chunkRich`, `repairRichTables`,
  `neutralizeRichMedia`, `extractTrailingCover`.
- **L2 — draft engine:** `createDraftStreamer` — throttle / keepalive /
  typing-heartbeat / preview-cap / drain state machine for live drafts,
  with overridable `DraftConstants`.
- **L3 — turn-loop bridge:** `runTelegramTurn` — `snapshot → stream →
  drive draft → finalize → reply`, with rollback-on-error/throw,
  never-throws-out, and the cover/chunking/fallback send orchestration
  (`sendReply`). You implement four thin interfaces; the kit owns the rest.
- **`/deepagents` (optional):** `streamAgent` + `toAgentStream` — adapts a
  deepagents/langgraph agent to the kit's `AgentStream` contract.

## Transport vs. orchestration

You provide a **`BotClient`** of *raw* Bot API primitives (one HTTP call
each — `sendMessage`, `sendRichMessage`, `sendPhoto`, `sendChatAction`,
`sendMessageDraft`, `sendRichMessageDraft`). The kit owns ALL orchestration
over them: chunking, HTML rendering, the rich→classic / photo→text 400
fallbacks, and the trailing-cover photo flow. Your primitives throw the
kit-exported `TelegramApiError` on a Bot API error so the deterministic-400
fallbacks work.

## Quick start (with deepagents)

```ts
import { runTelegramTurn, TelegramApiError } from 'telegram-agent-kit';
import { toAgentStream } from 'telegram-agent-kit/deepagents';
import type { BotClient } from 'telegram-agent-kit';

// 1. A thin BotClient over the Bot API (raw primitives; throw TelegramApiError).
const client: BotClient = {
  async sendMessage({ chatId, text, parseMode }, signal) {
    await call('sendMessage', { chat_id: chatId, text, parse_mode: parseMode }, signal);
  },
  // ...sendRichMessage / sendPhoto / sendChatAction / sendMessageDraft / sendRichMessageDraft
};

// 2. Drive one turn (per incoming Telegram message).
await runTelegramTurn({
  chatKey: { chatId, agentId: 'main' },
  userText,
  draftId: updateId, // non-zero, unique per turn
  rich: true,
  client,
  agentStream: toAgentStream(agent), // your deepagents agent
  checkpointer: {
    snapshot: (threadId) => saver.snapshotId(threadId),
    rollback: (threadId, id) => saver.rollbackThread(threadId, id),
  },
  threadStore: {
    resolve: (key) => threads.resolve(key.chatId, key.agentId),
    touch: (key, now) => threads.touch(key.chatId, key.agentId, now),
  },
  log: console,
  hooks: {
    // optional, app-specific: auth, voice STT, red-flag gates, failover notices
    preStream: ({ userText }) => (isEmergency(userText) ? { skip: true } : undefined),
  },
});

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

## The four interfaces

- **`BotClient`** — raw transport primitives (above).
- **`AgentStream`** — `(input, { threadId, signal }) => AsyncIterable<RenderEvent>`.
  `threadId` MUST reach the agent so the checkpointer writes to the same
  thread the kit snapshots/rolls back. `toAgentStream` does this for
  deepagents.
- **`Checkpointer`** — `{ snapshot(threadId), rollback(threadId, id) }`.
- **`ThreadStore`** — `{ resolve(chatKey, now), touch(chatKey, now) }`,
  keyed by `{ chatId, agentId }` (so two bots over one chat id don't
  collide).

## License

MIT
