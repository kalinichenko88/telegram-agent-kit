import type { AgentStream } from '../bridge/interfaces.ts';
import { streamAgent } from './stream-agent.ts';

type Agent = Parameters<typeof streamAgent>[0];

const RESERVED = new Set([
  'thread_id',
  // Legacy alias for `checkpoint_id`: the installed @langchain/langgraph-checkpoint
  // still resolves it via getCheckpointId() (`checkpoint_id || thread_ts`), so a
  // caller could resume from a hand-picked checkpoint through this key alone even
  // with `checkpoint_id` stripped. Strip it too.
  'thread_ts',
  'checkpoint_id',
  'checkpoint_ns',
  'checkpoint_map',
  'run_id',
]);

// LangGraph stamps its internal execution-control config under this prefix
// (e.g. `__pregel_checkpointer`, which Pregel reads off `configurable` to
// override the agent's own checkpointer — see langgraph's pregel/index.js).
// These are framework-internal; a caller must never be able to inject them.
const RESERVED_PREFIX = '__pregel_';

/** Strip LangGraph-reserved keys from a caller-supplied configurable bag so
 *  the kit retains full control over checkpoint routing and execution. */
export function stripReservedKeys(
  configurable: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(configurable).filter(
      ([k]) => !RESERVED.has(k) && !k.startsWith(RESERVED_PREFIX),
    ),
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
