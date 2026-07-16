import type { RunnableConfig } from '@langchain/core/runnables';
import type { createDeepAgent } from 'deepagents';

import type { RenderEvent, StreamInput } from '../bridge/interfaces.ts';

type Agent = ReturnType<typeof createDeepAgent>;

type LangGraphEvent = {
  event: string;
  metadata?: { langgraph_node?: string };
  data?: { chunk?: { content?: unknown } };
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
        const text = extractText(ev.data?.chunk?.content);
        if (text) yield { type: 'token', text };
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
