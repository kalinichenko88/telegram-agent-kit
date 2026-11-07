const TELEGRAM_LIMIT = 4096;
/** Headroom under TELEGRAM_LIMIT for the classic chunker. */
const CHUNK_TARGET = 4000;
/** Telegram's rich-message text limit (vs the classic 4096). */
const RICH_LIMIT = 32768;

/** Split into ≤TELEGRAM_LIMIT UTF-16-code-unit chunks without severing a
 *  surrogate pair. Prefers paragraph/line boundaries, hard-cuts otherwise.
 *  A chunk can be blank on its own, as the '\n' between a blank line and a
 *  long line. Telegram refuses a blank message, so a caller that sends the
 *  chunks skips such a chunk with isBlankText, as sendClassic does. */
export function chunkText(text: string): string[] {
  if (text.length <= TELEGRAM_LIMIT) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > TELEGRAM_LIMIT) {
    let cut = rest.lastIndexOf('\n\n', CHUNK_TARGET);
    if (cut < 1) cut = rest.lastIndexOf('\n', CHUNK_TARGET);
    // A newline cut cannot split a pair: the unit at the cut is '\n'. Only a
    // hard cut can, so only it goes through safeSlice. Each chunk is non-empty:
    // a newline cut is at least 1, and safeSlice moves a cut back by one unit.
    const chunk = cut < 1 ? safeSlice(rest, CHUNK_TARGET) : rest.slice(0, cut);
    chunks.push(chunk);
    rest = rest.slice(chunk.length);
  }
  if (rest.length > 0) chunks.push(rest);

  return chunks;
}

/** Surrogate-safe hard truncation to `max` UTF-16 code units. The one home of
 *  the pair rule: chunkText, chunkRich and the draft cap all cut through it.
 *  The cut moves back one unit only for a real pair — a high surrogate at
 *  `max - 1` and a low one at `max`. A lone high surrogate has nothing to
 *  sever, so it stays; trimming it could return '' and stall a caller that
 *  advances by the result's length. */
export function safeSlice(text: string, max: number): string {
  if (text.length <= max) return text;
  const high = text.charCodeAt(max - 1);
  const low = text.charCodeAt(max);
  const splitsPair =
    high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;

  return text.slice(0, splitsPair ? max - 1 : max);
}

/** Block-aware splitter for rich markdown. Most replies fit RICH_LIMIT in one
 *  message; when they don't, split only on blank-line (paragraph) boundaries
 *  so a table/list/quote is never cut. A single block over the limit is
 *  hard-cut surrogate-safely (rare — see spec §9). */
export function chunkRich(md: string): string[] {
  if (md.length <= RICH_LIMIT) return [md];
  const out: string[] = [];
  let cur = '';
  for (const block of md.split('\n\n')) {
    const candidate = cur === '' ? block : `${cur}\n\n${block}`;
    if (candidate.length <= RICH_LIMIT) {
      cur = candidate;
      continue;
    }
    if (cur !== '') {
      out.push(cur);
      cur = '';
    }
    if (block.length <= RICH_LIMIT) {
      cur = block;
      continue;
    }
    let rest = block;
    while (rest.length > RICH_LIMIT) {
      const cut = safeSlice(rest, RICH_LIMIT);
      out.push(cut);
      rest = rest.slice(cut.length);
    }
    cur = rest;
  }
  if (cur !== '') out.push(cur);

  return out;
}
