# The draft feed: plan and tool progress

While a turn runs, the draft shows a **feed** above the growing answer — the agent's plan
with per-step progress, plus a line per tool call:

```
🧠 load_skill(`nutrition`)…
📋 Plan
✔️ f̶i̶n̶d̶ ̶t̶h̶e̶ ̶w̶e̶e̶k̶'̶s̶ ̶e̶n̶t̶r̶i̶e̶s̶
🔘 total the calories
⬜ compare against the target
🔧 `query_journal`…
📝 logged: lunch, 620 kcal
─────
Over the week you ate 14,200 kcal —
```

Nothing here reaches the sent message: the final `sendMessage` carries only the reply, and
a real message wipes every live draft in the chat, so the feed disappears on its own.

Three properties are load-bearing, and all three were settled by watching a live chat
rather than reasoned about:

- **The reply is always last.** The client repaints every character of a draft whose
  middle changed, so a streaming token must be a pure append to the tail. Put the feed
  below the answer and every token repaints the whole draft.
- **The feed is append-only, and the plan is a block *in* it** — anchored where the agent
  first wrote it, not pinned as a header. A header reorders the feed the instant the plan
  arrives (a tool line that was on top jumps under it); anchoring it means nothing ever
  moves. Repaints then cost one plan status flip or one tool call, not one token.
- **Only one live draft exists per chat.** Writing with a second `draft_id` *replaces* the
  bubble rather than adding one, so plan and answer share a single draft. (The MTProto
  docs suggest otherwise; the Bot API does not behave that way.)

With `telegram-agent-kit/deepagents` this needs **no wiring at all** — the adapter turns
`write_todos` into `plan` events and labels skill loads (a `read_file` on
`/skills/<name>/SKILL.md`). Note that deepagents 1.12 dropped `write_todos` from its
default middleware stack (it now ships only in the Codex harness profile), so on 1.12+
pass `middleware: [todoListMiddleware()]` (from `langchain`) to `createDeepAgent` if you
want plans. Two optional knobs shape the rest:

```ts
await runTelegramTurn({
  // …
  feedConstants: {
    planTitle: '📋 План',              // the heading defaults to English
    icons: { active: '⏳' },           // merged key by key, not replaced wholesale
    maxLines: 5,                       // status lines kept; the plan is never evicted
  },
  // Your tools in your words. `null` hides a call, `undefined` defers to the
  // stream's own label and then to the bare `🔧 \`name\`…`.
  formatTool: ({ name, args }) =>
    name === 'write_journal'
      ? `📝 logged: ${(args as { meal: string }).meal}`
      : name === 'read_state'
        ? null
        : undefined,
});
```

Everything else — `renderFeed`, `strikeThrough`, `PLAN_BLOCK`, `DEFAULT_FEED_CONSTANTS` —
is exported if you want to render a feed somewhere else, but no turn needs it.

If your `AgentStream` is not deepagents, emit `plan` events yourself
(`{ type: 'plan', items: [{ text, status: 'pending' | 'active' | 'done' }] }`, the whole
list every time — the kit does not reconcile deltas) and optionally set `label` on a
`tool_start` to suggest a line for it.
