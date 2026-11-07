# Design guarantees

These are intentional and enforced by tests:

- **`mdToTelegramHtml` is total** — it never throws on any LLM output. The send path
  also wraps it and falls back to plain text as defence-in-depth.
- **Deterministic `400` fallbacks** keyed off `isBadRequest`: rich → classic HTML →
  plain text, and photo → text. Any non-`400` error always propagates.
- **`runTelegramTurn` never throws out** — snapshot happens only after a turn isn't
  skipped, rollback fires only on a real failure (and only if `hooks.shouldRollback`
  allows it), and draft teardown is idempotent.
- **Surrogate-safe splitting** — chunking never severs a UTF-16 surrogate pair.
- **One turn at a time per chat** — `createTurnQueue` serializes by `ChatKey`, and one
  task failing never wedges the turns queued behind it.
