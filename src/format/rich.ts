/** GFM table delimiter row — `|---|:--:|--:|` (alignment colons optional,
 *  leading/trailing pipe optional). */
const TABLE_DELIM_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const isPipeLine = (line: string): boolean => line.includes('|');

/** A fully-fenced table row — trimmed line both opens and closes with `|`. Used
 *  to spot orphaned rows without swallowing prose that merely mentions a pipe. */
const isTableRowLine = (line: string): boolean => /^\s*\|.*\|\s*$/.test(line);

/** A block is a GFM table iff its first line is a pipe row and its second is a
 *  delimiter row (the CommonMark/GFM tables extension). */
function isTableBlock(lines: string[]): boolean {
  return (
    lines.length >= 2 &&
    isPipeLine(lines[0] ?? '') &&
    TABLE_DELIM_RE.test(lines[1] ?? '')
  );
}

/** Orphaned table rows: every line is a fenced table row, but the block is NOT
 *  itself a table (it has no header+delimiter of its own). The fenced-row check
 *  (vs. a bare `|`) keeps a prose line that merely contains a pipe from being
 *  pulled into the table. */
function isPipeParagraph(lines: string[]): boolean {
  return (
    lines.length >= 1 && lines.every(isTableRowLine) && !isTableBlock(lines)
  );
}

/** A block an orphan row may fold into: a GFM table (header + delimiter) that is
 *  STILL a table at its end — its ENTIRE body after the delimiter is fenced
 *  table rows, with no prose break anywhere. A block that OPENS as a table but
 *  whose body contains ANY non-table line — a caption the model put a plain line
 *  (not a blank line) below the body, or prose buried mid-body before a trailing
 *  stray pipe line — has had its table "end" early and is NOT eligible: folding
 *  an orphan there would glue the row onto non-table content, violating the
 *  "non-table content untouched" invariant. `isTableBlock` inspects only the
 *  first two lines and a last-line-only check misses prose buried mid-body, so
 *  the WHOLE body is validated (codex). */
function endsAsTable(lines: string[]): boolean {
  return isTableBlock(lines) && lines.slice(2).every(isTableRowLine);
}

/** An open code region at a block boundary: a fenced-code block (its marker char
 *  `` ` `` / `~` + run length) OR an HTML `<pre>`/`<code>` region. Tracked so a
 *  blank-line-split table INSIDE code is recognised as a literal example, not an
 *  orphaned table — the SAME code regions `neutralizeRichMedia` skips, so both
 *  transforms on the send path agree on what is literal code. */
type CodeRegion =
  | { kind: 'fence'; char: string; len: number }
  | { kind: 'html'; tag: 'pre' | 'code' };

/** A line whose start (≤3 spaces of indent) is a `` ``` `` / `~~~` run — a fence
 *  opener, or (matching-or-longer run, empty info string) a fence closer. */
const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})(.*)/;

/** An HTML `<pre>`/`<code>` open or close tag. Opens allow attributes
 *  (`<code class="…">`); the `(?:\s[^>]*)?` guard keeps `<codex>`/`<press>` out.
 *  Mirrors the `<pre>`/`<code>` branches of `RICH_MEDIA_RE`. The tag NAME is
 *  captured (group 1 opens, group 2 closes) so the region is keyed off the name
 *  itself — a substring scan of the whole match would read `<code class="pre">`
 *  as a `<pre>` region, whose `</code>` then never closes it. */
const HTML_CODE_TAG_RE = /<(pre|code)(?:\s[^>]*)?>|<\/(pre|code)>/gi;

/** Advance HTML `<pre>`/`<code>` region state across one line's tags. From
 *  `null`, the first OPEN tag enters that region (a stray close tag is ignored);
 *  inside a region only the matching close exits it (lazy to the first close,
 *  like `RICH_MEDIA_RE`). Any other tag on the line is region content. */
function advanceHtmlLine(
  open: CodeRegion | null,
  line: string,
): CodeRegion | null {
  let cur = open;
  for (const m of line.matchAll(HTML_CODE_TAG_RE)) {
    const closing = m[0][1] === '/';
    const tag = (m[1] ?? m[2])?.toLowerCase() === 'pre' ? 'pre' : 'code';
    if (cur === null) {
      if (!closing) cur = { kind: 'html', tag };
    } else if (cur.kind === 'html' && closing && tag === cur.tag) {
      cur = null;
    }
  }

  return cur;
}

/** Advance fenced-code AND HTML `<pre>`/`<code>` state across a block's lines,
 *  tracking the SINGLE region open at the block boundary. A fence marker owns
 *  its whole line, so fence transitions are checked per line before any HTML
 *  scan — a ```-fenced `<pre>` stays content, and a `<pre>`-wrapped ``` stays
 *  content (only that region's closer ends it). Backtick-fence opener rules
 *  match the CommonMark subset `neutralizeRichMedia` encodes (a backtick fence's
 *  info string may not contain a backtick; a closer is a same-char run AT LEAST
 *  as long on its OWN line). An unterminated fence is code through EOF (matching
 *  `neutralizeRichMedia`); an unterminated `<pre>`/`<code>` here keeps the region
 *  open through EOF too — conservative (it only suppresses a repair that would
 *  run past a malformed open tag), where `neutralizeRichMedia` skips only CLOSED
 *  HTML regions. */
function advanceCodeRegion(
  open: CodeRegion | null,
  lines: string[],
): CodeRegion | null {
  let cur = open;
  for (const line of lines) {
    if (cur?.kind === 'html') {
      cur = advanceHtmlLine(cur, line); // only the matching close ends it
      continue;
    }
    const m = FENCE_LINE_RE.exec(line);
    if (cur?.kind === 'fence') {
      // Inside a fence: only this fence's closer matters; all else is content.
      if (m !== null) {
        const run = m[1] ?? '';
        if (
          (run[0] ?? '') === cur.char &&
          run.length >= cur.len &&
          (m[2] ?? '').trim() === ''
        )
          cur = null; // valid closer
      }
      continue;
    }
    // cur === null: a fence opener owns its whole line; else scan for HTML tags.
    if (m !== null) {
      const run = m[1] ?? '';
      const info = m[2] ?? '';
      const char = run[0] ?? '';
      if (char === '`' && info.includes('`')) {
        cur = advanceHtmlLine(null, line); // not a valid backtick opener
      } else {
        cur = { kind: 'fence', char, len: run.length };
      }
      continue;
    }
    cur = advanceHtmlLine(null, line);
  }

  return cur;
}

/** Re-absorb table rows the model detached with a blank line. A GFM table ends
 *  at a blank line, so a reply that puts a summary/total row a blank line below
 *  the body (observed live: `| Итого |` after `\n\n`, with cells that DID match
 *  the header) turns that row into a standalone paragraph — Telegram's rich
 *  renderer then prints it with literal pipes instead of inside the table. This
 *  drops the separating blank line whenever a pipe-only paragraph (not itself a
 *  new header+delimiter table) directly follows a table, rejoining the orphan;
 *  it repeats so several stacked orphan rows all fold back in. Genuinely
 *  separate tables (the next block has its own delimiter) and non-table content
 *  are left untouched. Code regions are tracked and skipped — both fenced code
 *  blocks (`` ``` `` / `~~~`) AND HTML `<pre>`/`<code>` regions: a blank-line-
 *  split table inside one is a literal example, not an orphan, so it is left
 *  verbatim (mirroring `neutralizeRichMedia`'s code-region skip — both run on
 *  the same send path, so they must agree on what is literal code). Merge
 *  eligibility of the preceding block is *tracked as it is emitted* (a table
 *  emitted OUTSIDE any code region whose last line is still a table row), never
 *  recomputed from its text — a table-shaped block that was code inside a region
 *  still looks like a table once the region closes, so an outside orphan must not
 *  fold into it, and a block that opens as a table but whose body contains
 *  non-table prose (mid-body or trailing) is not eligible either (else the orphan
 *  glues onto non-table content). Pure and total. */
export function repairRichTables(md: string): string {
  if (!md.includes('|')) return md; // fast path: no tables possible
  const out: string[] = [];
  let region: CodeRegion | null = null; // open code region at this block boundary
  // Whether the last pushed `out` block is a real GFM table emitted OUTSIDE any
  // code region AND still ENDING in a table row — the only block an orphan row
  // may fold into. Tracked rather than recomputed from `prev`, because a
  // table-shaped block that was literal code INSIDE a region still LOOKS like a
  // table after the region closes (its split passes isTableBlock), and folding
  // an outside orphan into that example would rewrite code. The whole-body table
  // check (`endsAsTable`) also rejects a block that opens as a table but whose
  // body contains prose (mid-body or trailing), so an orphan never glues onto
  // non-table content (codex).
  let prevTable = false;
  for (const block of md.split('\n\n')) {
    const lines = block.split('\n');
    // `region` here is the state ENTERING this block: non-null ⇒ the block (and
    // the blank line before it) is literal code, never a paragraph break.
    const insideCode = region !== null;
    const prev = out[out.length - 1];
    if (
      !insideCode &&
      prev !== undefined &&
      prevTable &&
      isPipeParagraph(lines)
    ) {
      out[out.length - 1] = `${prev}\n${block}`;
      // Folding orphan rows in keeps the block a table → prevTable stays true.
    } else {
      out.push(block);
      prevTable = !insideCode && endsAsTable(lines);
    }
    region = advanceCodeRegion(region, lines);
  }

  return out.join('\n\n');
}

/** A whole line that is exactly one `![alt](http(s)://…)` image token. HTTP(S)
 *  required (matches RICH_MEDIA_RE's media branch); an angle-bracketed or tg://
 *  URL does not match. `[^)]*` swallows an optional "title" after the URL. */
const TRAILING_COVER_RE = /^!\[[^\]]*\]\(\s*(https?:\/\/[^\s)]+)[^)]*\)$/;

/** True if line `idx` sits inside an open code region — a fenced ``` / ~~~ block
 *  OR an HTML <pre>/<code> region — given the lines before it. A trailing image
 *  line inside code is a literal example, not a cover. Delegates to
 *  advanceCodeRegion so it shares neutralizeRichMedia's exact code-region rules
 *  (run-length-aware fence close, lazy HTML regions) rather than re-deriving a
 *  weaker fence scan. */
function insideCodeRegion(lines: string[], idx: number): boolean {
  return advanceCodeRegion(null, lines.slice(0, idx)) !== null;
}

/** Extract a standalone cover image that is the LAST non-empty line of `md`:
 *  the whole line is a single `![alt](http(s)://…)` token. Returns the URL plus
 *  the body (the reply with that line removed, trailing whitespace trimmed).
 *  Anything else — no image, an image mid-text, an inline image, a
 *  non-HTTP(S)/angle-bracketed URL, or an image line inside an open code region —
 *  returns null. Narrow by design: only a standalone trailing line triggers the
 *  photo path, so non-media replies and inline URLs never fire it. */
export function extractTrailingCover(
  md: string,
): { url: string; body: string } | null {
  // Cheap reject before the split/scan: a cover line always ends in `)`, so a
  // reply whose last non-blank char isn't `)` can't carry one. Skips the work on
  // every cover-less reply (all main/health turns, most media turns).
  let end = md.length - 1;
  while (end >= 0 && /\s/.test(md[end] ?? '')) end--;
  if (end < 0 || md[end] !== ')') return null;
  const lines = md.split('\n');
  let i = lines.length - 1;
  while (i >= 0 && (lines[i] ?? '').trim() === '') i--;
  if (i < 0) return null;
  const m = TRAILING_COVER_RE.exec((lines[i] ?? '').trim());
  if (m === null) return null;
  if (insideCodeRegion(lines, i)) return null;
  const url = m[1] ?? '';
  const body = lines.slice(0, i).join('\n').replace(/\s+$/, '');

  return { url, body };
}

/** Skip-list + target alternation for `neutralizeRichMedia`. The code/escape
 *  branches match FIRST so an `![](…)` nested inside them is consumed as a
 *  skipped region and never reaches the media branch — only the media branch
 *  (the last alternative) carries the label/url/rest groups (the three leading
 *  groups exist only to length-track the fences/inline span; the HTML
 *  `<pre>`/`<code>` branches are non-capturing, so the media groups stay 4/5/6;
 *  see below). The fence branches
 *  are **line-aware**, per CommonMark (Telegram's rich-markdown parser family):
 *  an opener is a fence run at the start of a line (`^`/after a `\n`, ≤3 spaces
 *  of indent), and a closer is a same-char run AT LEAST as long as the opener
 *  on its OWN line (≤3 spaces indent, only trailing whitespace after) OR
 *  end-of-input. Anchoring both to fence lines is load-bearing: a same-length
 *  run that appears MID-LINE — e.g. inside a string literal like `"````"` — is
 *  NOT a closer, so a fenced block that quotes its own fence keeps its inner
 *  `![](…)` literal instead of mis-closing on it. Capturing the opener
 *  (`(`{3,})` / `(~{3,})`) and closing on its backreference (`\1`/`\2`, plus a
 *  trailing run so an over-length closer still matches) also lets a longer
 *  ```` ```` ````/`~~~~` fence wrap a shorter literal ``` ``` ```/`~~~` example.
 *  An *unterminated* opening fence is code through EOF (the `[\s\S]*` tail), so
 *  an `![](…)` after an unclosed fence is still literal code and is skipped.
 *  The inline branch anchors BOTH delimiters to COMPLETE, EQUAL-LENGTH backtick
 *  runs — opener `(?<!`)(`+)(?!`)`, close `(?<!`)\3(?!`)` — exactly CommonMark/GFM's
 *  "a backtick string is neither preceded nor followed by a backtick" rule. The
 *  lookbehind+lookahead on EACH end stop the opener (or close) from matching a
 *  prefix/suffix of a LONGER run: `` ` ![](…) `` `` (len-1 opener, only a len-2 run
 *  after) and `` `` ![](…) ` `` (len-2 opener, only a len-1 run after) are NOT spans,
 *  so their media still neutralizes; meanwhile a real `` … `` span keeps an inner
 *  single ` (and any nested media) literal. (An unterminated *inline* span is NOT
 *  code in CommonMark — its backtick is literal and trailing media still
 *  neutralizes — so the inline branch has no EOF fallback and no line anchoring:
 *  with no equal-length closer it simply doesn't match.) */
const RICH_MEDIA_RE = new RegExp(
  [
    // fenced code block (```+) — line-anchored open; close on a ≥open run that
    // owns its own line, else code through EOF.
    '(?:^|\\n)[ ]{0,3}(`{3,})[^\\n`]*(?:[\\s\\S]*?\\n[ ]{0,3}\\1`*[ \\t]*(?=\\n|$)|[\\s\\S]*)',
    // fenced code block (~~~+) — same, tilde info strings may contain backticks.
    '(?:^|\\n)[ ]{0,3}(~{3,})[^\\n]*(?:[\\s\\S]*?\\n[ ]{0,3}\\2~*[ \\t]*(?=\\n|$)|[\\s\\S]*)',
    // inline code span — both delimiters must be COMPLETE backtick runs of EQUAL
    // length (CommonMark/GFM): opener `(?<!`)(`+)(?!`)` is a whole run, close
    // `(?<!`)\3(?!`)` is a same-length whole run — never a prefix/suffix of a
    // longer one. So a `` … `` span keeps an inner single ` and its nested media
    // literal, while a stray ` adjacent to a longer run is not a span and its real
    // media still neutralizes.
    '(?<!`)(`+)(?!`)[\\s\\S]*?(?<!`)\\3(?!`)',
    // HTML code regions — Rich Markdown honors Telegram's Rich HTML tag subset
    // (docs: "can contain arbitrary HTML; supported tags are parsed as in Rich
    // HTML style"), in which <pre> (block) and <code> (inline) are fixed-width
    // code: their body is literal, so a nested ![](…) is NOT a media send and
    // must stay verbatim — same rationale as the backtick/tilde branches. Both
    // are NON-capturing so the media groups stay 4/5/6. Lazy to the first close;
    // <pre> is listed before <code> so a <pre><code>…</code></pre> is consumed as
    // ONE region. Optional attributes (e.g. <code class="language-ts">) are
    // allowed, and the `(?:\s[^>]*)?` guard keeps <codex>/<press> from matching.
    // Only CLOSED regions skip: an unterminated <pre>/<code> is left to
    // neutralize (the reply-safe default — and CommonMark would not treat a raw
    // open tag as code through EOF either, unlike a fence).
    '<pre(?:\\s[^>]*)?>[\\s\\S]*?</pre>',
    '<code(?:\\s[^>]*)?>[\\s\\S]*?</code>',
    // backslash escaping, parity-aware: consume escaped-backslash PAIRS first so
    // only an ODD run of backslashes escapes the `!`. `\![…]` (1 backslash) is a
    // literal `!`; `\\![…]` (2 backslashes = one literal `\`) leaves the `!`
    // unescaped, so the pair is skipped and the real media still neutralizes.
    '\\\\\\\\', // an escaped-backslash pair — skipped so it can't falsely escape a following `!`
    '\\\\!', // a single backslash + `!` — a genuinely escaped `!`, not a media start
    '!\\[([^\\]]*)\\]\\(\\s*(https?:\\/\\/[^\\s)]+)([^)]*)\\)', // media image (groups 4,5,6)
  ].join('|'),
  'g',
);

/** Rewrite HTTP(S) media image syntax `![alt](url ["title"])` to a plain link
 *  (bare URL when alt is empty) so a rich send never attempts a media block —
 *  media needs send-rights and fails for non-parse reasons (§4.2). `tg://`
 *  image syntax (custom emoji / date-time) is left untouched: it is an inline
 *  entity, not a media send. Dropping only the `!` keeps any "title" intact.
 *
 *  Code regions are skipped: a fenced block (closed, or unterminated and thus
 *  code through EOF), an inline code span, an HTML `<pre>`/`<code>` region
 *  (Telegram's Rich HTML subset — fixed-width code, body is literal), or a
 *  backslash-escaped `!` (only when preceded by an ODD run of backslashes — even
 *  runs are literal `\` pairs and leave the `!` live) is literal to Telegram
 *  (never a media send), so its `![](…)` must stay verbatim — neutralizing there
 *  would corrupt a literal Markdown/code example for no benefit. Pure and
 *  total. */
export function neutralizeRichMedia(md: string): string {
  return md.replace(
    RICH_MEDIA_RE,
    (
      match: string,
      // Groups 1-3 are the fence opens (backtick/tilde) and the inline-span
      // opener — captured only so each close can length-match via backreference;
      // unused here.
      _btFence?: string,
      _tildeFence?: string,
      _inlineOpen?: string,
      label?: string,
      url?: string,
      rest?: string,
    ) => {
      // Only the media branch fills label/url/rest; a code/escape region match
      // leaves url undefined → return it verbatim (literal to Telegram).
      if (url === undefined) return match;

      return label ? `[${label}](${url}${rest})` : url;
    },
  );
}
