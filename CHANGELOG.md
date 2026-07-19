# Changelog

## 0.3.1 — 2026-07-19

- **Turn-loop bridge** — a failed turn is no longer silent. An `error` event
  from the agent stream used to end the turn with nothing logged and nothing
  sent, leaving the user with a draft that just stopped moving; rollback then
  erased the turn from history, so the failure was unobservable afterwards.
  The message is now logged at error level, and a new opt-in `errorNotice`
  option on `runTelegramTurn` sends caller-owned copy to the chat as plain
  text. It is skipped when the turn was aborted via `signal`, since that
  cancellation is the caller's own.

## 0.3.0 — 2026-07-16

- **`/deepagents` (breaking)** — `RenderEvent` is now `token` | `error` only;
  the unconsumed `tool_start` / `tool_end` variants are removed, and
  `streamAgent` no longer emits them (the turn-loop only ever drove the draft
  and rollback off `token` / `error`). The `StreamAgentInput` export is dropped
  in favour of the shared `StreamInput` type, re-exported from the subpath.
- **Turn-loop bridge / Draft engine** — internal simplification: removed the
  unused `makeDraftStreamer` override (the draft streamer is still fully tunable
  via `draftConstants`) and the unused optional `Logger.info`.

## 0.2.0 — 2026-06-26

- **Turn-loop bridge** — `runTelegramTurn` now accepts a `configurable`
  bag that is forwarded verbatim to the `AgentStream` (and on through to
  the agent's run config), so callers can thread per-turn context to their
  agent.
- **`/deepagents`** — `toAgentStream` merges the caller's `configurable`
  under the kit-owned `thread_id`, stripping reserved LangGraph keys
  (`thread_id`, `thread_ts`, `checkpoint_*`, `run_id`, `__pregel_*`) so a
  caller bag can never clobber checkpointer routing.

## 0.1.0 — 2026-06-21

- Initial release:
  - **Formatting** — `mdToTelegramHtml` (totality + `partial` mode),
    `chunkText` / `safeSlice` / `chunkRich`, `repairRichTables`,
    `neutralizeRichMedia`, `extractTrailingCover`.
  - **Draft engine** — `createDraftStreamer` with overridable
    `DraftConstants`.
  - **Turn-loop bridge** — `runTelegramTurn` over injected `BotClient` /
    `AgentStream` / `Checkpointer` / `ThreadStore`, plus the kit-owned
    `sendReply` / `sendText` send orchestration (cover flow + chunking +
    rich→classic / photo→text fallbacks).
  - **Error contract** — `TelegramApiError` + `isBadRequest`.
  - **`/deepagents`** optional subpath — `streamAgent` + `toAgentStream`
    (langchain/deepagents as optional, type-only peers).
