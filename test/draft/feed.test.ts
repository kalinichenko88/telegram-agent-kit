import { expect, test } from 'vitest';

import type { PlanItem } from '../../src/bridge/interfaces.ts';
import {
  type FeedBlock,
  PLAN_BLOCK,
  renderFeed,
  strikeThrough,
} from '../../src/draft/feed.ts';

const PLAN: PlanItem[] = [
  { text: 'find', status: 'done' },
  { text: 'count', status: 'active' },
  { text: 'compare', status: 'pending' },
];

test('an empty feed renders the bare reply, byte for byte', () => {
  // The pre-feed contract: a turn with no tools must look exactly as it did.
  expect(renderFeed([], [], 'hello')).toBe('hello');
});

test('an empty reply renders the bare feed, with no orphan divider', () => {
  expect(renderFeed(['🔧 `a`…'], [], '')).toBe('🔧 `a`…');
});

test('both zones present → feed, divider, reply', () => {
  expect(renderFeed(['🔧 `a`…'], [], 'hi')).toBe('🔧 `a`…\n─────\nhi');
});

test('the reply always sits last, so a token is a pure append', () => {
  const blocks: FeedBlock[] = ['🔧 `a`…', PLAN_BLOCK];
  const one = renderFeed(blocks, PLAN, 'answ');
  const two = renderFeed(blocks, PLAN, 'answer');
  // Not merely "contains": the earlier frame must be a literal PREFIX of the
  // next. That is the whole reason the reply is last — the client repaints every
  // character of a draft whose middle changed, and an append is not a change to
  // the middle.
  expect(two.startsWith(one)).toBe(true);
});

test('the plan renders where its block sits, not as a header', () => {
  expect(renderFeed(['🧠 skill…', PLAN_BLOCK, '🔧 `q`…'], PLAN, '')).toBe(
    [
      '🧠 skill…',
      '📋 Plan',
      '✔️ f̶i̶n̶d̶',
      '🔘 count',
      '⬜ compare',
      '🔧 `q`…',
    ].join('\n'),
  );
});

test('a plan block with no items disappears instead of leaving a bare heading', () => {
  expect(renderFeed(['🔧 `a`…', PLAN_BLOCK], [], 'hi')).toBe(
    '🔧 `a`…\n─────\nhi',
  );
});

test('the ring keeps the newest lines and drops the oldest', () => {
  const blocks = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'];
  expect(renderFeed(blocks, [], '', { maxLines: 3 })).toBe('l5\nl6\nl7');
});

test('the ring never evicts the plan, and the plan holds its position', () => {
  // The plan is the one block worth keeping for the whole turn: letting the ring
  // drop it would make the plan vanish on any tool-heavy turn, which is exactly
  // the turn where progress matters most.
  const blocks: FeedBlock[] = ['l1', PLAN_BLOCK, 'l2', 'l3', 'l4', 'l5'];
  expect(renderFeed(blocks, PLAN, '', { maxLines: 2 })).toBe(
    ['📋 Plan', '✔️ f̶i̶n̶d̶', '🔘 count', '⬜ compare', 'l4', 'l5'].join('\n'),
  );
});

test('icons merge key by key instead of replacing the whole set', () => {
  expect(
    renderFeed([PLAN_BLOCK], PLAN, '', {
      planTitle: '📋 План',
      icons: { active: '⏳' },
    }),
  ).toBe(['📋 План', '✔️ f̶i̶n̶d̶', '⏳ count', '⬜ compare'].join('\n'));
});

test('strikeThrough survives surrogate pairs and emoji sequences', () => {
  // Per GRAPHEME, not per code unit or code point: code units sever surrogate
  // pairs, and code points drop the bar between an emoji base and its ZWJ or
  // variation selector, blowing the sequence apart into separate glyphs.
  expect(strikeThrough('ab')).toBe('a̶b̶');
  expect(strikeThrough('🧑‍🚀x')).toBe('🧑‍🚀̶x̶');
  expect(strikeThrough('')).toBe('');
});

test('only done items are struck', () => {
  const out = renderFeed([PLAN_BLOCK], PLAN, '');
  expect(out).toContain('f̶i̶n̶d̶');
  expect(out).toContain('🔘 count');
  expect(out).not.toContain('c̶o̶u̶n̶t̶');
});
