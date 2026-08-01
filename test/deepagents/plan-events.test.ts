import { expect, test } from 'vitest';

import {
  planItems,
  skillName,
  toolArgs,
} from '../../src/deepagents/stream-agent.ts';

// LangGraph reports tool arguments in two different shapes and the kit has to
// survive both — before this normalization the string shape silently defeated
// every consumer, including the skill relabel that predates the plan feed.
test('tool args are unwrapped from the {input: "<json>"} shape', () => {
  expect(toolArgs({ input: '{"file_path":"/skills/x/SKILL.md"}' })).toEqual({
    file_path: '/skills/x/SKILL.md',
  });
});

test('an already-parsed argument object passes through untouched', () => {
  const args = { file_path: '/a.md' };
  expect(toolArgs(args)).toBe(args);
});

test('a tool whose own parameter is a string named input keeps its args', () => {
  // Unwrapping only when the inner string parses to a plain object is what keeps
  // this from eating a real parameter. Arrays and scalars are not argument bags.
  expect(toolArgs({ input: 'just some prose' })).toEqual({
    input: 'just some prose',
  });
  expect(toolArgs({ input: '[1,2]' })).toEqual({ input: '[1,2]' });
  expect(toolArgs({ input: '42' })).toEqual({ input: '42' });
  expect(toolArgs(undefined)).toBe(undefined);
});

// `planItems` and `skillName` are the whole of the kit's knowledge about
// deepagents' tool vocabulary. They live here rather than in the core turn loop
// precisely so the core can stay ignorant of tool names — these tests are what
// keeps that knowledge honest as deepagents moves.

test('write_todos maps onto plan items, status for status', () => {
  // Shape verified against deepagents 1.10:
  // `{ todos: { content: string; status: 'completed'|'in_progress'|'pending' }[] }`.
  expect(
    planItems('write_todos', {
      todos: [
        { content: 'find', status: 'completed' },
        { content: 'count', status: 'in_progress' },
        { content: 'compare', status: 'pending' },
      ],
    }),
  ).toEqual([
    { text: 'find', status: 'done' },
    { text: 'count', status: 'active' },
    { text: 'compare', status: 'pending' },
  ]);
});

test('an unknown status degrades to pending rather than rendering undefined', () => {
  expect(
    planItems('write_todos', { todos: [{ content: 'x', status: 'blocked' }] }),
  ).toEqual([{ text: 'x', status: 'pending' }]);
});

test('items without string content are skipped, not rendered as undefined', () => {
  expect(
    planItems('write_todos', {
      todos: [
        { status: 'pending' },
        null,
        { content: 'ok', status: 'pending' },
      ],
    }),
  ).toEqual([{ text: 'ok', status: 'pending' }]);
});

test('anything unrecognized returns null and stays an ordinary tool call', () => {
  // A hand-rolled todo tool with another arg shape must degrade to a plain
  // `🔧 write_todos…` line rather than replacing the plan with an empty one.
  expect(planItems('read_file', { todos: [] })).toBe(null);
  expect(planItems('write_todos', undefined)).toBe(null);
  expect(planItems('write_todos', { todos: 'nope' })).toBe(null);
  expect(planItems('write_todos', { todos: [] })).toBe(null);
  expect(planItems('write_todos', { todos: [{ status: 'pending' }] })).toBe(
    null,
  );
});

test('a skill load is recognized by its path, any other read_file is not', () => {
  expect(
    skillName('read_file', { file_path: '/skills/food-logging/SKILL.md' }),
  ).toBe('food-logging');
  expect(skillName('read_file', { file_path: '/notes/todo.md' })).toBe(null);
  expect(skillName('read_file', { file_path: '/skills/x/other.md' })).toBe(
    null,
  );
  expect(skillName('write_file', { file_path: '/skills/x/SKILL.md' })).toBe(
    null,
  );
  expect(skillName('read_file', undefined)).toBe(null);
});
