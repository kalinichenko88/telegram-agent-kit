# Changelog

## 0.7.1 — 2026-07-30

- **The blank-text guard moved into `sendText`, the primitive that actually
  throws.** 0.7.0 guarded only `runTelegramTurn`, leaving every other caller
  unprotected — and callers reach the send path directly: a consuming app's
  digest and nudge jobs hand model output straight to `sendReply`. A chain that
  goes mute end to end (the residue 0.9.0-style empty-retry logic leaves behind)
  therefore still threw `400 text must be non-empty` out of the job's send
  instead of skipping quietly. `sendText` now returns early on text with no
  visible characters; `isBlankText` is the one shared predicate. A reply that is
  only a trailing cover image is unaffected — the guard sits below
  `extractTrailingCover`, so the photo still goes out.
- **The draft-clear condition is back to `if (status)`, as before 0.7.0.** The
  widening rested on this file's claim that empty draft text clears the draft
  outright, and a consuming app's channel notes record the opposite (an empty
  draft renders a "Thinking…" placeholder — which is why that app never sends
  empty text on abort). Neither claim is verified against the live Bot API, and
  the failure mode of being wrong is worse than the cosmetic issue it fixed: a
  fresh "Thinking…" rendered directly above the `emptyNotice` that says the turn
  is over, with the ~30s draft expiry refreshed. An invisible-only reply
  therefore keeps its stale 🔧 frame, exactly as in 0.6.0. The call site now
  states the uncertainty instead of asserting either behaviour.

## 0.7.0 — 2026-07-30

- **Turn-loop bridge** — a reply made of nothing but invisible characters no longer
  escapes the turn as an unhandled send failure. `String.trim` does not strip
  `\p{Cf}` (U+200B zero-width space, U+FEFF, U+2060, soft hyphen …), so the
  empty-reply guard passed a bare U+200B straight into `sendReply`, where the Bot
  API answered `400 text must be non-empty` — on the HTML send and again on the
  plain-text retry, whose throw left `runTelegramTurn`'s send step entirely.
  Observed in prod 2026-07-30: a local fallback model closed a food-logging turn
  with one U+200B; the diary row was written, the user got silence, and the only
  trace was a `telegram turn failed` line. The blank check now ignores format
  characters (predicate only — `\p{Cf}` also covers the ZWJ inside emoji
  sequences, and the sent text is never rewritten), and such a turn also clears
  its draft: a U+200B token resets the tool status, so the old `if (status)`
  branch left the `🔧` frame standing.
- **Turn-loop bridge** — new opt-in `emptyNotice`, the completed-turn sibling of
  `errorNotice`: a plain-text line sent when a turn finishes with no reply text
  (ended on a tool call, or answered invisibly). Kept separate from `errorNotice`
  because an empty turn is **not** rolled back — its tool writes stand, and
  error-shaped wording invites a re-send that repeats them. Omitted → the previous
  warn-only behaviour, unchanged.

## 0.6.0 — 2026-07-24

- **Turn-loop bridge** — a skill load now reads as `🧠 load_skill(\`name\`)…` in the
  live draft instead of the generic `🔧 \`read_file\`…`. Skills load via progressive
  disclosure: there is no dedicated tool — the model just reads
  `/skills/<name>/SKILL.md` with `read_file`, which made a skill load
  indistinguishable from reading any other file. The new `skillName` helper spots
  that specific read (a `read_file` whose `file_path` ends `/skills/<name>/SKILL.md`)
  and relabels only the transient status line; a plain `read_file` still shows 🔧, and
  the status is still never folded into the sent message.
- **Turn-loop bridge / /deepagents** — `RenderEvent`'s `tool_start` now carries an
  `args` field so the tool input reaches the draft (the file path is what the relabel
  keys off). The `/deepagents` adapter forwards it from the LangGraph event's
  `data.input`.

## 0.5.0 — 2026-07-22

- **Turn-loop bridge** — the live draft now shows which tool the agent is running.
  A turn that stopped streaming to call a tool used to leave the draft frozen, which
  from the chat is indistinguishable from the bot having hung. `RenderEvent` gains a
  `tool_start` case, rendered as a transient `🔧 \`name\`…` line under the draft.
  The status is held separately from the reply and **never** folded into it, so the
  message that actually gets sent is still exactly the concatenated tokens; the next
  token clears the line rather than stacking under it. A turn that *ends* on a tool
  call rewrites the status-free text directly, because `finalize()` stops the draft
  animation but leaves its last frame standing — without that, a tool-only turn
  (tools ran, no tokens) would strand a 🔧 on screen with no message to explain it.
  No new option or callback: the format is fixed until a second consumer disagrees.
- **/deepagents** — `streamAgent` now maps `on_tool_start` onto the new event,
  behind the same nested-agent filter the tokens use, so a delegated subagent's tool
  calls stay out of the root draft. That the `checkpoint_ns` `|` separator
  discriminates on tool starts too was verified against a real delegation rather
  than assumed: a root tool start carries `tools:<uuid>`, one inside a subagent
  carries `tools:<uuid>|tools:<uuid>`. The token branch's `langgraph_node ===
  'model_request'` gate is deliberately *not* reused — tool starts run on the
  `tools` node, so it would have dropped every tool call. The built-in `task` tool
  surfaces as a normal root tool call, so delegation reads as the tool it is instead
  of as a gap in the narration.

## 0.4.1 — 2026-07-20

- **/deepagents** — `streamAgent` no longer leaks a nested agent's tokens into the
  parent stream. A delegated agent — a `subagents` entry, or the built-in `task`
  tool — runs its *own* `model_request` node and LangChain replays its events into
  the parent's `streamEvents`, so the previous `langgraph_node` check could not tell
  the levels apart and a subagent's monologue interleaved with the reply the user
  was reading. Nesting is now read off `checkpoint_ns`, which is `|`-joined per
  level: the root is a single segment, anything delegated carries a separator.
  Deliberately not keyed off `lc_agent_name` even though subagents do carry it —
  `createDeepAgent({ name })` stamps that key on the *root* too, so a name-based
  filter would have silenced streaming outright, with no error, the first time
  anyone named their agent. Naming the root is now a no-op for streaming, pinned by
  a test.
- **Docs** — `sendReply` / `sendText` now document the shape of their `opts`
  argument, which the README previously referenced without ever describing.

## 0.4.0 — 2026-07-19

- **Turn-loop bridge / Formatting** — `rich: true` now means *rich when it buys
  something*, not *rich always*. Bot API rich messages have no body-typography
  field, so every reply sent through the rich renderer looked unlike a normal
  message; routing prose to classic is the only lever a bot has. A new
  `needsRich(md)` predicate asks whether the text carries structure only the rich
  renderer can draw — today, a GFM table — and drafts and final messages go rich
  only when it does. Tables inside a fence or an HTML `<pre>`/`<code>` region are
  literal examples and do not count. `rich: false` is unchanged and still the
  kill-switch: HTML only, always.
- **Turn-loop bridge / Draft engine** — the rich gate is applied per chunk and per
  draft write, not once per reply. Previously a table in the first chunk sent every
  later prose chunk rich, and drafts were never gated at all, so a turn could
  animate rich and then land classic. `needsRich` also now scans line pairs rather
  than block starts, so a table under a lead-in line, heading, list, or closing
  fence — and tables in CRLF output — are detected instead of falling through to
  classic, which has no table renderer and shipped literal pipes.
  `neutralizeRichMedia` moved into the classic path too, which was rendering raw
  `![alt](url)`.
- **Requires Node 20+** (was 18+). Node 18 reached end-of-life in April 2025 and is
  no longer covered by CI; the tested matrix is now Node 20, 22, and 24, plus Bun.
  Runtime behaviour is unchanged — the core still has zero dependencies.

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
