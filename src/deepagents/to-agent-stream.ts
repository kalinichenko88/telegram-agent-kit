import type { AgentStream } from '../bridge/interfaces.ts';
import { streamAgent } from './stream-agent.ts';

type Agent = Parameters<typeof streamAgent>[0];

/** Adapt a deepagents agent to the kit's runtime-agnostic AgentStream: build
 *  the langgraph config from context.threadId, forward the signal. This is the
 *  ONLY place the langgraph config shape lives. */
export function toAgentStream(agent: Agent): AgentStream {
  return (input, context) =>
    streamAgent(
      agent,
      input,
      { configurable: { thread_id: context.threadId } },
      context.signal,
    );
}
