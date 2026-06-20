import { describe, expect, test } from 'vitest';

import {
  extractTrailingCover,
  neutralizeRichMedia,
  repairRichTables,
} from '../../src/format/rich.ts';

describe('repairRichTables', () => {
  test('rejoins a blank-line-orphaned total row back into the table', () => {
    // The exact prod failure: the model separates the `| Итого |` row from the
    // table body with a blank line, which terminates the GFM table so Telegram
    // renders the orphan as a literal-pipe paragraph (cells matched the header).
    const md = [
      '| № | Продукт | Ккал |',
      '|---|---|---:|',
      '| 1 | Сосиски | 700 |',
      '| 2 | Курица | 330 |',
      '',
      '| Итого |  | **1030** |',
      '',
      'Если хочешь, могу ещё.',
    ].join('\n');
    const expected = [
      '| № | Продукт | Ккал |',
      '|---|---|---:|',
      '| 1 | Сосиски | 700 |',
      '| 2 | Курица | 330 |',
      '| Итого |  | **1030** |',
      '',
      'Если хочешь, могу ещё.',
    ].join('\n');
    expect(repairRichTables(md)).toBe(expected);
  });

  test('leaves two genuinely separate tables apart', () => {
    const md = [
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '| c | d |',
      '|---|---|',
      '| 3 | 4 |',
    ].join('\n');
    expect(repairRichTables(md)).toBe(md);
  });

  test('does not fuse pipe paragraphs that were never a table', () => {
    const md = ['| a | b |', '', '| c | d |'].join('\n');
    expect(repairRichTables(md)).toBe(md);
  });

  test('leaves a table followed by prose untouched', () => {
    const md = ['| a | b |', '|---|---|', '| 1 | 2 |', '', 'just text'].join(
      '\n',
    );
    expect(repairRichTables(md)).toBe(md);
  });

  test('does not swallow a prose line that merely contains a pipe', () => {
    const md = [
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      'Use the | operator.',
    ].join('\n');
    expect(repairRichTables(md)).toBe(md);
  });

  test('leaves an orphan row apart when the table block ends in prose', () => {
    // Regression (codex): the first block OPENS as a table (header + delimiter)
    // but ENDS with a prose line the model did NOT separate with a blank line.
    // isTableBlock inspects only the first two lines, so eligibility must also
    // require the block to END as a table row — otherwise the orphan total folds
    // onto the prose, rewriting non-table content.
    const md = [
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      'Note below the table.',
      '',
      '| Total | 3 |',
    ].join('\n');
    expect(repairRichTables(md)).toBe(md);
  });

  test('leaves an orphan row apart when prose is buried mid-body before a trailing pipe line', () => {
    // Regression (codex): the block OPENS as a table (header + delimiter) and its
    // LAST line is pipe-shaped, but a prose line sits MID-body — so the table
    // broke there and the trailing pipe line is no longer table content. A
    // last-line-only eligibility check would wrongly fold the orphan total here,
    // gluing it onto non-table content; validating the WHOLE body after the
    // delimiter keeps the orphan apart.
    const md = [
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      'Note before pipe row',
      '| not a table continuation |',
      '',
      '| Total | 3 |',
    ].join('\n');
    expect(repairRichTables(md)).toBe(md);
  });

  test('folds in several stacked orphan rows the model split apart', () => {
    // Documented invariant ("repeats so several stacked orphan rows all fold
    // back in"): each rejoin must leave a still-valid table block so the next
    // orphan paragraph also folds into it.
    const md = [
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '| x | y |',
      '',
      '| z | w |',
    ].join('\n');
    const expected = [
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '| x | y |',
      '| z | w |',
    ].join('\n');
    expect(repairRichTables(md)).toBe(expected);
  });

  test('folds in a multi-row orphan paragraph', () => {
    // Exercises the `lines.every(isTableRowLine)` branch: the orphan block is
    // itself several rows separated by single newlines.
    const md = [
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '| x | y |\n| z | w |',
    ].join('\n');
    const expected = [
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '| x | y |',
      '| z | w |',
    ].join('\n');
    expect(repairRichTables(md)).toBe(expected);
  });

  test('leaves a blank-line-split table inside a fenced code block untouched', () => {
    // The fence-state tracker recognises the ``` block, so a literal markdown
    // example a user pasted is left verbatim even though its inner blank line
    // isolates the total row.
    const md = [
      '```',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '| Total | 3 |',
      '```',
    ].join('\n');
    expect(repairRichTables(md)).toBe(md);
  });

  test('leaves a fenced table verbatim when the opener stands on its own block', () => {
    // Regression (codex P2): a blank line right after the opening ``` puts the
    // fence marker in its OWN \n\n split-block, isolating the table body and
    // total row. Without fence-awareness the orphan-total merge rewrote literal
    // code; the fence tracker now skips everything between the fences, matching
    // neutralizeRichMedia's code-region invariant.
    const md = [
      '```',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '| Total | 3 |',
      '',
      '```',
    ].join('\n');
    expect(repairRichTables(md)).toBe(md);
  });

  test('does not fold an outside orphan into a table that was code inside a fence', () => {
    // Regression (codex P3): the opener stands on its own \n\n-block, so the
    // table example becomes the fence's CONTENT block ending in the closer.
    // After the fence closes, that block still LOOKS like a table (header +
    // delimiter), but it was literal code — an orphan total row OUTSIDE the
    // fence must NOT fold into it. Eligibility is tracked as the block is
    // emitted (table outside a fence), not recomputed from `prev`.
    const md = [
      '```',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '```',
      '',
      '| Total | 3 |',
    ].join('\n');
    expect(repairRichTables(md)).toBe(md);
  });

  test('still repairs an orphaned total row after a closed fenced block', () => {
    // Fence-awareness must not over-suppress: once the fence closes, a genuine
    // blank-line-orphaned total row OUTSIDE it is still folded back in.
    const md = [
      '```',
      'code',
      '```',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '| Total | 3 |',
    ].join('\n');
    const expected = [
      '```',
      'code',
      '```',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '| Total | 3 |',
    ].join('\n');
    expect(repairRichTables(md)).toBe(expected);
  });

  test('leaves a blank-line-split table inside an HTML <pre> region untouched', () => {
    // Regression (codex): repairRichTables runs BEFORE neutralizeRichMedia, so it
    // must honor the SAME code-region skip — Telegram's Rich HTML subset treats
    // <pre> as literal fixed-width code. Without HTML-awareness the orphan-total
    // merge dropped the blank line inside <pre>, rewriting a literal example.
    const md = [
      '<pre>',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '| Total | 3 |',
      '',
      '</pre>',
    ].join('\n');
    expect(repairRichTables(md)).toBe(md);
  });

  test('leaves a blank-line-split table inside an HTML <code> region untouched', () => {
    const md = [
      '<code>',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '| Total | 3 |',
      '</code>',
    ].join('\n');
    expect(repairRichTables(md)).toBe(md);
  });

  test('leaves a blank-line-split table inside a nested <pre><code> region untouched', () => {
    // The <pre> region is lazy to its own </pre>, so a <pre><code>…</code></pre>
    // (the docs' language-tagged block shape) is one skipped region — same as
    // neutralizeRichMedia consumes it.
    const md = [
      '<pre><code class="language-md">',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '| Total | 3 |',
      '</code></pre>',
    ].join('\n');
    expect(repairRichTables(md)).toBe(md);
  });

  test('still repairs an orphaned total row after a closed HTML <pre> region', () => {
    // HTML-awareness must not over-suppress: once </pre> closes, a genuine
    // blank-line-orphaned total row OUTSIDE it is still folded back in.
    const md = [
      '<pre>',
      'code',
      '</pre>',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '| Total | 3 |',
    ].join('\n');
    const expected = [
      '<pre>',
      'code',
      '</pre>',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '| Total | 3 |',
    ].join('\n');
    expect(repairRichTables(md)).toBe(expected);
  });

  test('still repairs after a <code> whose attributes contain "pre"', () => {
    // Regression (codex P3): the region must be keyed off the tag NAME, not a
    // substring scan of the whole match. `<code class="pre">` is a <code> region;
    // a substring scan reads it as <pre>, so the closing </code> never matches and
    // the region stays open through EOF — silently suppressing every later table
    // repair. Here the code region closes correctly, so the genuine orphan folds.
    const md = [
      '<code class="pre">x</code>',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '| Total | 3 |',
    ].join('\n');
    const expected = [
      '<code class="pre">x</code>',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '| Total | 3 |',
    ].join('\n');
    expect(repairRichTables(md)).toBe(expected);
  });

  test('is identity for markdown with no pipes', () => {
    const md = 'hello\n\nworld';
    expect(repairRichTables(md)).toBe(md);
  });
});

describe('neutralizeRichMedia', () => {
  test('rewrites HTTP(S) image syntax to a link, dropping the !', () => {
    expect(neutralizeRichMedia('![alt](https://x.org/a.jpg)')).toBe(
      '[alt](https://x.org/a.jpg)',
    );
  });
  test('empty alt becomes a bare URL', () => {
    expect(neutralizeRichMedia('![](https://x.org/a.jpg)')).toBe(
      'https://x.org/a.jpg',
    );
  });
  test('preserves a "title" on a labelled image', () => {
    expect(neutralizeRichMedia('![a](https://x.org/a.jpg "cap")')).toBe(
      '[a](https://x.org/a.jpg "cap")',
    );
  });
  test('leaves tg://emoji and tg://time image syntax untouched', () => {
    expect(neutralizeRichMedia('![](tg://emoji?id=5)')).toBe(
      '![](tg://emoji?id=5)',
    );
    expect(neutralizeRichMedia('![22:45](tg://time?unix=1)')).toBe(
      '![22:45](tg://time?unix=1)',
    );
  });
  test('leaves a normal link untouched', () => {
    expect(neutralizeRichMedia('[a](https://x.org)')).toBe(
      '[a](https://x.org)',
    );
  });
  test('neutralizes multiple HTTP(S) images on one line', () => {
    expect(
      neutralizeRichMedia(
        '![](https://x.org/a.jpg) and ![b](https://x.org/b.jpg)',
      ),
    ).toBe('https://x.org/a.jpg and [b](https://x.org/b.jpg)');
  });
  test('leaves image syntax inside an inline code span verbatim', () => {
    expect(neutralizeRichMedia('`![alt](https://x.org/a.jpg)`')).toBe(
      '`![alt](https://x.org/a.jpg)`',
    );
  });
  test('a `` span keeps an inner single backtick and its media verbatim', () => {
    // CommonMark/GFM: a 2-backtick span closes only on a 2-backtick run, so the
    // single ` inside is content — not a closer. The inner `![](…)` must stay
    // literal (regression: the inline branch closed on the single backtick
    // before, exposing the image to neutralization → content corruption).
    const md = '`` marker ` ![](https://x.org/a.jpg) ``';
    expect(neutralizeRichMedia(md)).toBe(md);
  });
  test('still neutralizes media after a closed `` span', () => {
    // The length-aware close stays lazy: a 2-backtick span ends at its first
    // 2-backtick closer, so media outside it is still neutralized.
    expect(neutralizeRichMedia('``code``\n![](https://x.org/a.jpg)')).toBe(
      '``code``\nhttps://x.org/a.jpg',
    );
  });
  test('neutralizes media when a len-1 opener has only a longer run after', () => {
    // CommonMark/GFM: a code span needs an EQUAL-length closer. `` ` … `` `` is a
    // len-1 opener with only a len-2 run after — NOT a span, so the ! image is real
    // media (regression: the close matched a suffix of the longer run before, so
    // the media slipped through to sendRichMessage).
    expect(neutralizeRichMedia('` ![](https://x.org/a.jpg) ``')).toBe(
      '` https://x.org/a.jpg ``',
    );
  });
  test('neutralizes media when a len-2 opener has only a shorter run after', () => {
    // Mirror of the above: `` `` … ` `` is a len-2 opener with only a len-1 run
    // after — no equal-length closer, so it is NOT a span and the media is real
    // (regression: the opener re-anchored onto a single backtick of the run).
    expect(neutralizeRichMedia('`` ![](https://x.org/a.jpg) `')).toBe(
      '`` https://x.org/a.jpg `',
    );
  });
  test('leaves image syntax inside a fenced code block verbatim', () => {
    const md = 'see\n```\n![](https://x.org/a.jpg)\n```\nend';
    expect(neutralizeRichMedia(md)).toBe(md);
  });
  test('leaves image syntax inside an unterminated ``` fence verbatim', () => {
    // CommonMark: an opening fence with no closer is code through EOF, so the
    // `![](…)` is literal code — must not be neutralized.
    const md = 'see\n```\n![](https://x.org/a.jpg)';
    expect(neutralizeRichMedia(md)).toBe(md);
  });
  test('leaves image syntax inside an unterminated ~~~ fence verbatim', () => {
    const md = '~~~\n![](https://x.org/a.jpg)';
    expect(neutralizeRichMedia(md)).toBe(md);
  });
  test('a longer ```` fence keeps a literal ``` example with media verbatim', () => {
    // CommonMark: the closing fence must be >= the opening run, so a 4-backtick
    // fence can wrap a literal 3-backtick example — the inner `![](…)` is still
    // code and must NOT be neutralized (regression: closed on any 3-run before).
    const md = '````\n```\n![](https://x.org/a.jpg)\n````';
    expect(neutralizeRichMedia(md)).toBe(md);
  });
  test('a longer ~~~~ fence keeps a literal ~~~ example with media verbatim', () => {
    const md = '~~~~\n~~~\n![](https://x.org/a.jpg)\n~~~~';
    expect(neutralizeRichMedia(md)).toBe(md);
  });
  test('a fence quoting its own run mid-line does not mis-close', () => {
    // CommonMark closers must own their line (≤3 spaces indent, only trailing
    // whitespace). A same-length run INSIDE a line — e.g. a string literal
    // `"````"` — is content, not a closer, so the block (and its inner media)
    // stays verbatim (regression: closed on any mid-line run before).
    const md = '````\nconst marker = "````";\n![](https://x.org/a.jpg)\n````';
    expect(neutralizeRichMedia(md)).toBe(md);
  });
  test('a tilde fence quoting its own run mid-line does not mis-close', () => {
    const md = '~~~~\nx = "~~~~";\n![](https://x.org/a.jpg)\n~~~~';
    expect(neutralizeRichMedia(md)).toBe(md);
  });
  test('still neutralizes media after a closed ```` fence', () => {
    // The length-tracked close must stay lazy: a closed 4-backtick fence ends at
    // its 4-backtick closer, so trailing media outside it is still neutralized.
    expect(
      neutralizeRichMedia('````\ncode\n````\n![](https://x.org/a.jpg)'),
    ).toBe('````\ncode\n````\nhttps://x.org/a.jpg');
  });
  test('still neutralizes media after a closed fenced block', () => {
    // Regression guard: the open-fence-to-EOF branch must stay lazy so a closed
    // fence stops at its closer and trailing media is still neutralized.
    expect(
      neutralizeRichMedia('```\ncode\n```\n![](https://x.org/a.jpg)'),
    ).toBe('```\ncode\n```\nhttps://x.org/a.jpg');
  });
  test('leaves a backslash-escaped image start verbatim', () => {
    expect(neutralizeRichMedia('\\![alt](https://x.org/a.jpg)')).toBe(
      '\\![alt](https://x.org/a.jpg)',
    );
  });
  test('neutralizes media after an EVEN run of backslashes (parity)', () => {
    // CommonMark/GFM: two backslashes are one literal `\`, so the ! is NOT escaped
    // and the image is real media (regression: the `\!` skip matched the second
    // backslash + ! and skipped real media).
    expect(neutralizeRichMedia('\\\\![alt](https://x.org/a.jpg)')).toBe(
      '\\\\[alt](https://x.org/a.jpg)',
    );
  });
  test('leaves media after an ODD run of backslashes verbatim (parity)', () => {
    // Three backslashes = one literal `\` + an escaped `!`, so the ! is literal
    // and the image stays verbatim.
    expect(neutralizeRichMedia('\\\\\\![alt](https://x.org/a.jpg)')).toBe(
      '\\\\\\![alt](https://x.org/a.jpg)',
    );
  });
  test('neutralizes media outside code while preserving media inside it', () => {
    expect(
      neutralizeRichMedia(
        '![](https://x.org/out.jpg) `![](https://x.org/in.jpg)`',
      ),
    ).toBe('https://x.org/out.jpg `![](https://x.org/in.jpg)`');
  });
  test('leaves image syntax inside an HTML <code> region verbatim', () => {
    // Rich Markdown honors Telegram's Rich HTML tag subset, in which <code> is
    // inline fixed-width code — its body is literal, so the nested image is NOT a
    // media send and must stay verbatim (else a literal code example corrupts).
    const md = '<code>![alt](https://x.org/a.jpg)</code>';
    expect(neutralizeRichMedia(md)).toBe(md);
  });
  test('leaves image syntax inside an HTML <pre> region verbatim', () => {
    const md = '<pre>![](https://x.org/a.jpg)</pre>';
    expect(neutralizeRichMedia(md)).toBe(md);
  });
  test('leaves image syntax inside a nested <pre><code> region verbatim', () => {
    // The <pre> branch is lazy to its own </pre>, so a <pre><code>…</code></pre>
    // (the docs' language-tagged block shape) is consumed as ONE skipped region.
    const md =
      '<pre><code class="language-md">![](https://x.org/a.jpg)</code></pre>';
    expect(neutralizeRichMedia(md)).toBe(md);
  });
  test('preserves attribute-bearing <code> while neutralizing media outside it', () => {
    expect(
      neutralizeRichMedia(
        '![](https://x.org/out.jpg) <code class="x">![](https://x.org/in.jpg)</code>',
      ),
    ).toBe(
      'https://x.org/out.jpg <code class="x">![](https://x.org/in.jpg)</code>',
    );
  });
  test('does not treat a bare "code" word or <codex> as a code region', () => {
    // The `<code` literal + `(?:\s[^>]*)?` guard means plain text "code:" and a
    // <codex> tag are NOT code regions, so trailing real media still neutralizes.
    expect(neutralizeRichMedia('code: ![](https://x.org/a.jpg)')).toBe(
      'code: https://x.org/a.jpg',
    );
    expect(neutralizeRichMedia('<codex>![](https://x.org/a.jpg)')).toBe(
      '<codex>https://x.org/a.jpg',
    );
  });
});

describe('extractTrailingCover', () => {
  test('extracts a standalone trailing image line and strips it from the body', () => {
    expect(
      extractTrailingCover(
        'Смотри это.\n\n![обложка](https://img.example/x.jpg)',
      ),
    ).toEqual({ url: 'https://img.example/x.jpg', body: 'Смотри это.' });
  });
  test('empty alt is fine; a reply that is only the image yields an empty body', () => {
    expect(extractTrailingCover('![](https://img.example/x.jpg)')).toEqual({
      url: 'https://img.example/x.jpg',
      body: '',
    });
  });
  test('returns null when the last line is not an image', () => {
    expect(extractTrailingCover('Просто текст.')).toBeNull();
  });
  test('does not match an image that is not the last line', () => {
    expect(
      extractTrailingCover('![x](https://img.example/x.jpg)\nи ещё текст'),
    ).toBeNull();
  });
  test('does not match an inline image embedded in a text line', () => {
    expect(
      extractTrailingCover('вот ![x](https://img.example/x.jpg) тут'),
    ).toBeNull();
  });
  test('requires http(s) — a tg:// image is not a cover', () => {
    expect(extractTrailingCover('t\n\n![x](tg://emoji?id=5)')).toBeNull();
  });
  test('does not match an angle-bracket-wrapped URL', () => {
    expect(
      extractTrailingCover('t\n\n![x](<https://img.example/x.jpg>)'),
    ).toBeNull();
  });
  test('skips a trailing image line inside an unterminated code fence', () => {
    expect(
      extractTrailingCover('```\n![x](https://img.example/x.jpg)'),
    ).toBeNull();
  });
  test('skips a fenced image when a shorter same-char run is not a valid closer', () => {
    // CommonMark: a ~~~~ opener is only closed by a run >= 4 tildes, so the
    // inner ~~~ is content, not a closer — the image stays fenced code. Pins the
    // run-length-aware close (a char-only fence scan would wrongly extract it).
    expect(
      extractTrailingCover('~~~~\n~~~\n![x](https://img.example/x.jpg)'),
    ).toBeNull();
  });
  test('skips a trailing image inside an unterminated HTML <pre> region', () => {
    expect(
      extractTrailingCover('<pre>\n![x](https://img.example/x.jpg)'),
    ).toBeNull();
  });
  test('ignores an optional image "title" and captures only the URL', () => {
    expect(
      extractTrailingCover('t\n\n![x](https://img.example/x.jpg "cap")'),
    ).toEqual({ url: 'https://img.example/x.jpg', body: 't' });
  });
});

describe('extractTrailingCover — type pin', () => {
  test('returns { url, body } for a standalone trailing image', () => {
    expect(
      extractTrailingCover('hi there\n\n![cover](https://x/y.png)'),
    ).toEqual({
      url: 'https://x/y.png',
      body: 'hi there',
    });
  });
  test('returns null when no trailing image', () => {
    expect(extractTrailingCover('just text')).toBeNull();
  });
});
