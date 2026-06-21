# Changelog

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
