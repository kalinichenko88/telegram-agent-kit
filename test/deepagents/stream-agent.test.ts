import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import { AIMessageChunk } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import { createDeepAgent } from 'deepagents';
import { expect, test } from 'vitest';

import { streamAgent } from '../../src/deepagents/stream-agent.ts';

/** Scripted model driving a real delegation: the root delegates via the
 *  built-in `task` tool on its first turn, the subagent answers, then the root
 *  writes the final reply. Call-ordered rather than tool-inspecting so the same
 *  instance can back both levels (createAgent binds tools onto it twice). */
class ScriptedModel extends BaseChatModel {
  calls = 0;

  _llmType() {
    return 'scripted';
  }

  bindTools(): this {
    return this;
  }

  async *_streamResponseChunks(
    _messages: BaseMessage[],
    _options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    this.calls += 1;

    const emit = async (text: string, extra?: Record<string, unknown>) => {
      await runManager?.handleLLMNewToken(text);
      return new ChatGenerationChunk({
        text,
        message: new AIMessageChunk({ content: text, ...(extra ?? {}) }),
      });
    };

    if (this.calls === 1) {
      yield await emit('ROOT-A ');
      yield await emit('', {
        tool_call_chunks: [
          {
            name: 'task',
            args: JSON.stringify({
              description: 'do the thing',
              subagent_type: 'gp',
            }),
            id: 'call_1',
            index: 0,
            type: 'tool_call_chunk',
          },
        ],
      });
      return;
    }

    if (this.calls === 2) {
      yield await emit('SUB-1 ');
      yield await emit('SUB-2');
      return;
    }

    yield await emit('ROOT-B');
  }

  async _generate(): Promise<ChatResult> {
    throw new Error('scripted model: only the streaming path is exercised');
  }
}

function makeAgent(name?: string) {
  const model = new ScriptedModel({});
  const agent = createDeepAgent({
    model,
    ...(name ? { name } : {}),
    subagents: [
      {
        name: 'gp',
        description: 'general purpose',
        systemPrompt: 'you are a subagent',
      },
    ],
  });
  return { agent, model };
}

async function collect(
  agent: ReturnType<typeof makeAgent>['agent'],
  signal?: AbortSignal,
) {
  const out: string[] = [];
  const errors: string[] = [];
  for await (const ev of streamAgent(
    agent,
    { messages: [{ role: 'user', content: 'hi' }] },
    { configurable: { thread_id: 't1' } },
    signal,
  )) {
    if (ev.type === 'token') out.push(ev.text);
    if (ev.type === 'error') errors.push(ev.message);
  }
  return { text: out.join(''), errors };
}

test('root tokens reach the caller', async () => {
  const { agent } = makeAgent();
  const { text, errors } = await collect(agent);

  expect(errors).toEqual([]);
  expect(text).toBe('ROOT-A ROOT-B');
});

test('subagent tokens are dropped', async () => {
  const { agent, model } = makeAgent();
  const { text } = await collect(agent);

  // The subagent really did run — it just never reached the user.
  expect(model.calls).toBe(3);
  expect(text).not.toContain('SUB-1');
  expect(text).not.toContain('SUB-2');
});

// Regression guard for the trap that sank the `lc_agent_name` filter:
// createDeepAgent({ name }) stamps `lc_agent_name` on the ROOT as well as on
// subagents, so a name-based filter would silence the bot entirely — with no
// error anywhere. Nesting depth is independent of the caller's config, so
// naming the root must stay a no-op for streaming. See NESTED_NS in
// src/deepagents/stream-agent.ts.
test('naming the root agent does not silence it', async () => {
  const { agent } = makeAgent('root-bot');
  const { text, errors } = await collect(agent);

  expect(errors).toEqual([]);
  expect(text).toBe('ROOT-A ROOT-B');
  expect(text).not.toContain('SUB-');
});

test('abort yields a single canceled error event', async () => {
  const { agent } = makeAgent();
  const ctrl = new AbortController();
  ctrl.abort();

  const { errors } = await collect(agent, ctrl.signal);

  expect(errors).toEqual(['canceled']);
});
