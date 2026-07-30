/** Markdown → Telegram-HTML renderer (channel-local). Tokenize-on-raw,
 *  escape-at-emission, total (never throws). Deliberately NOT named
 *  markdown.ts — src/runtime/markdown.ts owns that name in greps. Spec:
 *  docs/superpowers/specs/2026-06-07-telegram-markdown-rendering-design.md */

const escapeHtml = (s: string): string =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const escapeAttr = (s: string): string =>
  escapeHtml(s).replaceAll('"', '&quot;');

type Mark = {
  marker: string;
  tag: 'b' | 'i' | 's';
  /** `_`-family never triggers intraword (word char before opener / after closer). */
  underscore: boolean;
  /** Single-char markers skip runs so `**` leftovers never pair at the `*` level. */
  single: boolean;
};

/** Inline precedence order (applied after code spans and links). */
const MARKS: Mark[] = [
  { marker: '**', tag: 'b', underscore: false, single: false },
  { marker: '__', tag: 'b', underscore: true, single: false },
  { marker: '*', tag: 'i', underscore: false, single: true },
  { marker: '_', tag: 'i', underscore: true, single: true },
  { marker: '~~', tag: 's', underscore: false, single: false },
];

const WORD_RE = /[\p{L}\p{N}_]/u; // Unicode: лог_еды is intraword too
const isWord = (ch: string | undefined): boolean =>
  ch !== undefined && WORD_RE.test(ch);
const isSpace = (ch: string | undefined): boolean =>
  ch !== undefined && /\s/.test(ch);

function findOpener(text: string, m: Mark, from: number): number {
  for (
    let p = text.indexOf(m.marker, from);
    p !== -1;
    p = text.indexOf(m.marker, p + 1)
  ) {
    const next = text[p + m.marker.length];
    if (next === undefined || isSpace(next)) continue; // flanking
    if (m.single && (next === m.marker || text[p - 1] === m.marker)) continue;
    if (m.underscore && isWord(text[p - 1])) continue; // intraword
    return p;
  }
  return -1;
}

function findCloser(text: string, m: Mark, from: number): number {
  for (
    let p = text.indexOf(m.marker, from);
    p !== -1;
    p = text.indexOf(m.marker, p + 1)
  ) {
    if (p === from) continue; // empty inner — `****` stays literal
    const prev = text[p - 1];
    if (prev === undefined || isSpace(prev)) continue; // flanking
    if (
      m.single &&
      (prev === m.marker || text[p + m.marker.length] === m.marker)
    )
      continue;
    if (m.underscore && isWord(text[p + m.marker.length])) continue;
    return p;
  }
  return -1;
}

/** Inline marks at one precedence level. Text before a pair drops a level
 *  (it holds no pair of this type), text after keeps scanning at this level
 *  (`**a** and **b**` formats both). Loops, not recursion, along the line —
 *  totality must hold for marker-spam inputs. */
function renderMarks(text: string, level: number): string {
  const m = MARKS[level];
  if (m === undefined) return escapeHtml(text);
  let out = '';
  let rest = text;
  for (;;) {
    const open = findOpener(rest, m, 0);
    if (open === -1) return out + renderMarks(rest, level + 1);
    const close = findCloser(rest, m, open + m.marker.length);
    if (close === -1) {
      // unpaired → marker stays literal; keep scanning past it at this level
      out += renderMarks(rest.slice(0, open + m.marker.length), level + 1);
      rest = rest.slice(open + m.marker.length);
      continue;
    }
    out +=
      renderMarks(rest.slice(0, open), level + 1) +
      `<${m.tag}>${renderMarks(
        rest.slice(open + m.marker.length, close),
        level + 1,
      )}</${m.tag}>`;
    rest = rest.slice(close + m.marker.length);
  }
}

/** Validates the URL part of a candidate link: http(s), no spaces/parens. */
const URL_RE = /^https?:\/\/[^\s()]*$/;

type LinkMatch = { index: number; length: number; label: string; url: string };

/** Index-based scan for the first complete `[label](http(s)://…)` — same
 *  semantics as the old /\[([^\]]*)\]\((https?:\/\/[^\s()]*)\)/ regex but
 *  linear: a backtracking regex re-scans the tail at every `[` and goes
 *  quadratic on bracket-heavy lines. Early-outs: no `]` (or no `)`) anywhere
 *  ahead means no later candidate can complete either. */
function matchLink(text: string): LinkMatch | null {
  let lb = text.indexOf('[');
  while (lb !== -1) {
    const rb = text.indexOf(']', lb + 1);
    if (rb === -1) return null; // no ] ahead — nothing can match
    if (text[rb + 1] === '(') {
      const rp = text.indexOf(')', rb + 2);
      if (rp === -1) return null; // no ) ahead — nothing can match
      const url = text.slice(rb + 2, rp);
      if (URL_RE.test(url)) {
        return {
          index: lb,
          length: rp + 1 - lb,
          label: text.slice(lb + 1, rb),
          url,
        };
      }
    }
    lb = text.indexOf('[', lb + 1);
  }
  return null;
}

/** Complete http(s) links only; the URL is an opaque attribute (emitted
 *  attribute-escaped exactly once, never rescanned by lower levels). */
function renderLinks(text: string): string {
  let out = '';
  let rest = text;
  for (;;) {
    const m = matchLink(rest);
    if (m === null) return out + renderMarks(rest, 0);
    out +=
      renderMarks(rest.slice(0, m.index), 0) +
      `<a href="${escapeAttr(m.url)}">${renderMarks(m.label, 0)}</a>`;
    rest = rest.slice(m.index + m.length);
  }
}

/** One line of inline markdown → HTML: code spans pair first (their content is
 *  opaque to links and marks), then links, then marks. */
function renderInline(text: string): string {
  let out = '';
  let rest = text;
  for (;;) {
    const open = rest.indexOf('`');
    if (open === -1) return out + renderLinks(rest);
    const close = rest.indexOf('`', open + 1);
    if (close === -1) return out + renderLinks(rest); // lone backtick stays literal
    if (close === open + 1) {
      // `` — empty span, both backticks literal
      out += renderLinks(rest.slice(0, close + 1));
      rest = rest.slice(close + 1);
      continue;
    }
    out +=
      renderLinks(rest.slice(0, open)) +
      `<code>${escapeHtml(rest.slice(open + 1, close))}</code>`;
    rest = rest.slice(close + 1);
  }
}

const FENCE_OPEN_RE = /^(`{3,}|~{3,})\s*(.*)$/;
const TICK_CLOSE_RE = /^`{3,}\s*$/;
const TILDE_CLOSE_RE = /^~{3,}\s*$/;
const LANG_RE = /^[A-Za-z0-9_+-]+$/;

/** First whitespace-delimited info token, allowlisted — the info string is
 *  untrusted model input and must never break out of the class attribute. */
function fenceLang(info: string): string | null {
  const token = info.trim().split(/\s+/)[0] ?? '';
  return token !== '' && LANG_RE.test(token) ? token : null;
}

function renderFence(body: string, lang: string | null): string {
  const code = escapeHtml(body);
  return lang === null
    ? `<pre>${code}</pre>`
    : `<pre><code class="language-${lang}">${code}</code></pre>`;
}

/** Inline rendering only ever emits `<code>` spans (fences/`<pre>` are
 *  block-level), so a code span is `<code>…</code>` whose content is
 *  escaped — `</code>` can never appear inside it, making the match
 *  unambiguous. */
const CODE_SPAN_RE = /<code>[\s\S]*?<\/code>/g;

/** Wrap a heading's inline-rendered HTML in `<b>`, but never let the bold
 *  span a code span: Telegram rejects a `code`/`pre` entity nested in
 *  bold/italic/etc. (tdlib: "Pre and Code can't be part of other entities,
 *  except blockquote"). `## See ` + "`foo`" emits
 *  `<b>See </b><code>foo</code>` — both formats survive with valid,
 *  non-overlapping nesting — instead of the rejected
 *  `<b>See <code>foo</code></b>`. Empty sides drop so no `<b></b>` is
 *  emitted (Telegram rejects empty entities too). */
function boldHeading(html: string): string {
  let out = '';
  let last = 0;
  for (const m of html.matchAll(CODE_SPAN_RE)) {
    const before = html.slice(last, m.index);
    if (before !== '') out += `<b>${before}</b>`;
    out += m[0];
    last = m.index + m[0].length;
  }
  const tail = html.slice(last);
  if (tail !== '') out += `<b>${tail}</b>`;
  return out;
}

export function mdToTelegramHtml(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const fence = FENCE_OPEN_RE.exec(line);
    if (fence !== null) {
      const closeRe = (fence[1] ?? '').startsWith('`')
        ? TICK_CLOSE_RE
        : TILDE_CLOSE_RE;
      const lang = fenceLang(fence[2] ?? '');
      let close = -1;
      for (let j = i + 1; j < lines.length; j += 1) {
        if (closeRe.test(lines[j] ?? '')) {
          close = j;
          break;
        }
      }
      if (close !== -1) {
        out.push(renderFence(lines.slice(i + 1, close).join('\n'), lang));
        i = close + 1;
      } else {
        // Unterminated: opener + everything after = opaque literal — code in
        // a mid-fence-split chunk is never mangled, no <pre> is invented.
        out.push(escapeHtml(lines.slice(i).join('\n')));
        i = lines.length;
      }
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quoted: string[] = [];
      let j = i;
      while (j < lines.length && /^>\s?/.test(lines[j] ?? '')) {
        quoted.push((lines[j] ?? '').replace(/^>\s?/, ''));
        j += 1;
      }
      const inner = quoted.map((q) => renderInline(q)).join('\n');
      // Telegram rejects an empty <blockquote>; a quote run with no real
      // content (a bare `>` line) stays literal rather than an empty tag.
      out.push(
        inner.trim() === ''
          ? escapeHtml(lines.slice(i, j).join('\n'))
          : `<blockquote>${inner}</blockquote>`,
      );
      i = j;
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading !== null) {
      out.push(boldHeading(renderInline(heading[1] ?? '')));
      i += 1;
      continue;
    }
    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
    if (bullet !== null) {
      out.push(`${bullet[1] ?? ''}• ${renderInline(bullet[2] ?? '')}`);
      i += 1;
      continue;
    }
    out.push(renderInline(line));
    i += 1;
  }
  return out.join('\n');
}
