import type { AgentStream } from '../bridge/interfaces.ts';
import { streamAgent } from './stream-agent.ts';

type Agent = Parameters<typeof streamAgent>[0];

const RESERVED = new Set([
  'thread_id',
  'checkpoint_id',
  'checkpoint_ns',
  'checkpoint_map',
  'run_id',
]);

/** Strip LangGraph-reserved keys from a caller-supplied configurable bag so
 *  the kit retains full control over checkpoint routing. */
export function stripReservedKeys(
  configurable: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(configurable).filter(([k]) => !RESERVED.has(k)),
  );
}

/** Adapt a deepagents agent to the kit's runtime-agnostic AgentStream: merge the
 *  caller's `configurable` bag (with reserved checkpoint-routing keys stripped)
 *  under the kit-owned `thread_id`, and forward the signal. The kit's `thread_id`
 *  is spread last so it always wins, even if stripping ever misses a key. This is
 *  the ONLY place the langgraph config shape lives. */
export function toAgentStream(agent: Agent): AgentStream {
  return (input, context) => {
    const extra = context.configurable ?? {};
    const safe = stripReservedKeys(extra);

    return streamAgent(
      agent,
      input,
      { configurable: { ...safe, thread_id: context.threadId } },
      context.signal,
    );
  };
}
