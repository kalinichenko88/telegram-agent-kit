import type { RunnableConfig } from '@langchain/core/runnables';
import type { createDeepAgent } from 'deepagents';

import type { RenderEvent } from '../bridge/interfaces.ts';

type Agent = ReturnType<typeof createDeepAgent>;

export type StreamAgentInput = {
  messages: Array<{ role: 'user'; content: string }>;
};

type LangGraphEvent = {
  event: string;
  run_id: string;
  name?: string;
  metadata?: { langgraph_node?: string };
  data?: {
    chunk?: { content?: unknown };
    input?: unknown;
    output?: unknown;
    error?: unknown;
  };
};

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

function extractToolError(output: unknown): string | undefined {
  if (typeof output !== 'object' || output === null) return undefined;
  const o = output as { status?: unknown; content?: unknown };
  if (o.status !== 'error') return undefined;
  const c = o.content;
  if (typeof c === 'string') return c;
  try {
    return JSON.stringify(c);
  } catch {
    return String(c);
  }
}

export async function* streamAgent(
  agent: Agent,
  input: StreamAgentInput,
  config: RunnableConfig,
  signal?: AbortSignal,
): AsyncIterable<RenderEvent> {
  const toolStart = new Map<string, number>();

  const iter = agent.streamEvents(input, {
    ...config,
    signal,
    version: 'v2',
  }) as AsyncIterable<LangGraphEvent>;

  try {
    for await (const ev of iter) {
      if (ev.event === 'on_chat_model_stream') {
        if (ev.metadata?.langgraph_node !== 'model_request') continue;
        const text = extractText(ev.data?.chunk?.content);
        if (text) yield { type: 'token', text };
      } else if (ev.event === 'on_tool_start') {
        toolStart.set(ev.run_id, Date.now());
        yield {
          type: 'tool_start',
          id: ev.run_id,
          name: ev.name ?? 'unknown',
          args: ev.data?.input,
        };
      } else if (ev.event === 'on_tool_end' || ev.event === 'on_tool_error') {
        const startedAt = toolStart.get(ev.run_id) ?? Date.now();
        toolStart.delete(ev.run_id);
        const error =
          ev.event === 'on_tool_error'
            ? ev.data?.error instanceof Error
              ? ev.data.error.message
              : String(ev.data?.error ?? 'tool error')
            : extractToolError(ev.data?.output);
        yield {
          type: 'tool_end',
          id: ev.run_id,
          durationMs: Date.now() - startedAt,
          ...(error !== undefined ? { error } : {}),
        };
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
