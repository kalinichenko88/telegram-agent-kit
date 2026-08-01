import type { PlanItem } from '../bridge/interfaces.ts';

/** Marks where the plan sits in the feed. The plan is a BLOCK OF THE FEED, not a
 *  pinned header: it renders where the agent first wrote it, and everything
 *  after it appends below. A header would have been simpler, but it reorders the
 *  feed the moment the plan arrives — a tool line that was on top jumps under it
 *  — and the client re-animates every character of a draft whose middle changed
 *  (measured against a live chat, 2026-08-01). Append-only keeps the reordering
 *  out of the picture entirely and confines re-animation to plan status flips. */
export const PLAN_BLOCK = Symbol('plan');

/** A feed entry: either a rendered status line, or the plan's anchor. */
export type FeedBlock = string | typeof PLAN_BLOCK;

export type FeedConstants = {
  /** Bullet per plan-item status. */
  icons: Record<PlanItem['status'], string>;
  /** Heading above the plan block. English by default; override per locale. */
  planTitle: string;
  /** How many status LINES stay visible (oldest drop first). The plan block is
   *  exempt — it is the one thing worth keeping for the whole turn, and letting
   *  the ring evict it would make the plan vanish on any tool-heavy turn. */
  maxLines: number;
  /** Divider between the feed and the reply. */
  separator: string;
};

export const DEFAULT_FEED_CONSTANTS: FeedConstants = {
  icons: { done: '✔️', active: '🔘', pending: '⬜' },
  planTitle: '📋 Plan',
  maxLines: 5,
  separator: '─────',
};

/** Overrides for `renderFeed`. `icons` is merged key-by-key rather than replaced
 *  wholesale, so `{ icons: { done: '☑' } }` keeps the other two instead of
 *  silently rendering `undefined` for them. */
export type FeedOverrides = Partial<Omit<FeedConstants, 'icons'>> & {
  icons?: Partial<FeedConstants['icons']>;
};

// Grapheme clusters, not code points: appending the combining bar after each
// code unit would sever surrogate pairs, and after each code point it would land
// INSIDE emoji sequences (between a base and its ZWJ or variation selector) and
// break them apart. `Intl.Segmenter` is native on every runtime the kit targets.
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Strike text through with U+0336 COMBINING LONG STROKE OVERLAY.
 *
 *  Deliberately NOT `<s>` + `parse_mode`: the draft primitive
 *  (`BotClient.sendMessageDraft`) is plain text, and taking it to HTML would
 *  mean escaping the model's reply inside the same frame and adding a 400
 *  fallback for a malformed one — a whole failure path bought for one visual
 *  effect. The combining bar needs neither, and renders identically. */
export function strikeThrough(text: string): string {
  return Array.from(GRAPHEMES.segment(text), (s) => `${s.segment}̶`).join('');
}

function renderPlan(
  plan: readonly PlanItem[],
  k: FeedConstants,
): string | null {
  if (plan.length === 0) return null;
  const lines = plan.map(
    (i) =>
      `${k.icons[i.status]} ${i.status === 'done' ? strikeThrough(i.text) : i.text}`,
  );

  return [k.planTitle, ...lines].join('\n');
}

/** Compose one live-draft frame: the feed, a divider, then the reply so far.
 *
 *  The reply always sits LAST so that a streaming token is a pure append to the
 *  tail. Put the feed below instead and every token becomes an edit to the
 *  middle of the draft, which the client repaints in full — the difference is
 *  plainly visible in a real chat.
 *
 *  Both zones collapse when empty, so a turn with no tools renders exactly the
 *  bare reply (byte for byte what pre-feed versions sent) and a turn that has
 *  not started talking yet renders the bare feed, with no orphan divider. */
export function renderFeed(
  blocks: readonly FeedBlock[],
  plan: readonly PlanItem[],
  reply: string,
  overrides?: FeedOverrides,
): string {
  const k: FeedConstants = {
    ...DEFAULT_FEED_CONSTANTS,
    ...overrides,
    icons: { ...DEFAULT_FEED_CONSTANTS.icons, ...overrides?.icons },
  };

  // Walk backwards so the ring keeps the NEWEST lines, then restore order. The
  // plan never spends budget and never drops, so it holds its position while
  // the lines around it age out.
  const visible: string[] = [];
  let budget = Math.max(0, k.maxLines);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block === PLAN_BLOCK) {
      const rendered = renderPlan(plan, k);
      if (rendered !== null) visible.unshift(rendered);
    } else if (block !== undefined && block !== '' && budget > 0) {
      budget -= 1;
      visible.unshift(block);
    }
  }

  const top = visible.join('\n');
  if (top === '') return reply;
  if (reply === '') return top;

  return `${top}\n${k.separator}\n${reply}`;
}
