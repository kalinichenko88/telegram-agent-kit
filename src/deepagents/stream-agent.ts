import type { RunnableConfig } from '@langchain/core/runnables';
import type { createDeepAgent } from 'deepagents';

import type { RenderEvent, StreamInput } from '../bridge/interfaces.ts';

type Agent = ReturnType<typeof createDeepAgent>;

type LangGraphEvent = {
  event: string;
  name?: string;
  metadata?: { langgraph_node?: string; checkpoint_ns?: string };
  data?: { chunk?: { content?: unknown } };
};

/** True for an event replayed from a delegated agent (a `subagents` entry or the
 *  built-in `task` tool) rather than produced by the root run. See NESTED_NS. */
function isNested(ev: LangGraphEvent): boolean {
  return ev.metadata?.checkpoint_ns?.includes('|') ?? false;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (p): p is { type: 'text'; text: string } =>
          typeof p === 'object' &&
          p !== null &&
          (p as { type?: unknown }).type === 'text' &&
          typeof (p as { text?: unknown }).text === 'string',
      )
      .map((p) => p.text)
      .join('');
  }
  return '';
}

export async function* streamAgent(
  agent: Agent,
  input: StreamInput,
  config: RunnableConfig,
  signal?: AbortSignal,
): AsyncIterable<RenderEvent> {
  const iter = agent.streamEvents(input, {
    ...config,
    signal,
    version: 'v2',
  }) as AsyncIterable<LangGraphEvent>;

  try {
    for await (const ev of iter) {
      if (ev.event === 'on_chat_model_stream') {
        if (ev.metadata?.langgraph_node !== 'model_request') continue;
        // NESTED_NS: a delegated agent (a `subagents` entry, or the built-in
        // `task` tool) runs its OWN `model_request` node and LangChain replays
        // its events into the parent's streamEvents — so `langgraph_node`
        // alone lets a subagent's monologue interleave with the root's reply.
        //
        // `checkpoint_ns` separates the levels structurally: the root's is a
        // single segment (`model_request:<uuid>`), while a delegated run is
        // `|`-joined per nesting level
        // (`tools:<uuid>|model_request:<uuid>`). One `|` means "not the root".
        //
        // Deliberately NOT keyed off `metadata.lc_agent_name` even though
        // subagents do carry it: `createDeepAgent({ name })` stamps
        // `lc_agent_name` on the ROOT too (langchain ReactAgent sets it for
        // any `options.name`), so naming the root — a harmless-looking thing
        // to do for logs — would silently drop every token with no error.
        // Nesting depth has no such coupling to the caller's config.
        if (isNested(ev)) continue;
        const text = extractText(ev.data?.chunk?.content);
        if (text) yield { type: 'token', text };
      } else if (ev.event === 'on_tool_start') {
        // Same nesting test as the tokens above, and verified to discriminate
        // on THIS event too rather than assumed: a root tool start carries
        // `checkpoint_ns: 'tools:<uuid>'`, while a tool called inside a
        // delegated subagent carries `'tools:<uuid>|tools:<uuid>'` — the `|`
        // separator is per nesting level regardless of event type.
        //
        // No `langgraph_node` gate here, unlike the token branch: tool starts
        // run on the `tools` node, not `model_request`, so reusing that check
        // would drop every tool call. Nesting alone is the filter.
        if (isNested(ev)) continue;
        yield { type: 'tool_start', name: ev.name ?? 'unknown' };
      }
    }
  } catch (err) {
    yield {
      type: 'error',
      message: signal?.aborted
        ? 'canceled'
        : err instanceof Error
          ? err.message
          : String(err),
    };
  }
}
