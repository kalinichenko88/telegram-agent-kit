# The four interfaces

You implement these; the kit drives them.

| Interface      | Shape                                                                 | Role |
| -------------- | --------------------------------------------------------------------- | ---- |
| `BotClient`    | `sendMessage`, `sendRichMessage`, `sendPhoto`, `sendChatAction`, `sendMessageDraft`, `sendRichMessageDraft` | Raw transport. Each throws `TelegramApiError` on a Bot API error, and bounds itself with a ceiling of its own — only the transport can cancel a request. |
| `AgentStream`  | `(input, { threadId, signal, configurable }) => AsyncIterable<RenderEvent>` | Your agent. `threadId` **must** reach it so the checkpointer writes to the snapshotted thread. `configurable` is an optional pass-through bag forwarded verbatim from `runTelegramTurn`'s `configurable` option. |
| `Checkpointer` | `{ snapshot(threadId), rollback(threadId, id) }`                       | Per-thread snapshot/rollback for clean recovery on a failed turn. |
| `ThreadStore`  | `{ resolve(chatKey, now), touch(chatKey, now) }`                      | Maps `{ chatId, agentId }` to a thread id (so two bots over one chat id don't collide). |

A `RenderEvent` is one of `token`, `tool_start`, `plan` or `error`. `token` text is
appended to the live draft *and* to the reply that gets sent. `tool_start` and `plan`
feed the draft only, and **never** become part of the sent message. An `error` rolls the
turn back (unless you veto it — see [Conditional rollback](conditional-rollback.md)), logs the message, and — if you pass
`errorNotice` — tells the user in the chat instead of going silent.

A turn can also *complete* with nothing to say: it ended on a tool call, or the model
answered with invisible characters only (a bare U+200B counts as text for `trim()` but is
empty to the Bot API). Both are treated as an empty reply — logged, and — if you pass
`emptyNotice` — said out loud. The draft is **not** blanked in either case: empty draft
text renders an empty bubble rather than clearing the draft, so the feed is left standing
as the only record of what the turn did, and it expires with the draft in ~30s (or the
moment `emptyNotice` lands, since any real message wipes every live draft in the chat).
The same check guards `sendText` itself, so a *direct* caller (a background job handing
model output to `sendReply`) skips the send — with a `telegram blank send skipped`
warning — instead of throwing a Bot API 400. A long reply is checked per chunk too: a
chunk that is blank on its own, as a lone newline at a cut, is skipped, and the rest of
the reply still goes out. `emptyNotice` is a **separate** line from
`errorNotice` on purpose: an empty turn is not rolled back, so whatever its tools wrote
stands, and "it broke" would invite a re-send that repeats the write.
