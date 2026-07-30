import { describe, expect, test } from 'vitest';

import { mdToTelegramHtml } from '../../src/format/md-to-html.ts';

describe('mdToTelegramHtml — inline marks (strict)', () => {
  test('renders bold', () => {
    expect(mdToTelegramHtml('**жирный**')).toBe('<b>жирный</b>');
    expect(mdToTelegramHtml('__жирный__')).toBe('<b>жирный</b>');
  });

  test('renders italic', () => {
    expect(mdToTelegramHtml('*курсив*')).toBe('<i>курсив</i>');
    expect(mdToTelegramHtml('_курсив_')).toBe('<i>курсив</i>');
  });

  test('renders strikethrough', () => {
    expect(mdToTelegramHtml('~~зачёркнуто~~')).toBe('<s>зачёркнуто</s>');
  });

  test('renders the motivating screenshot case', () => {
    expect(mdToTelegramHtml('Записал: **овсянка на воде — 100 г**.')).toBe(
      'Записал: <b>овсянка на воде — 100 г</b>.',
    );
  });

  test('escapes & < > in text', () => {
    expect(mdToTelegramHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  test('model-supplied HTML arrives as literal text', () => {
    expect(mdToTelegramHtml('<b>x</b>')).toBe('&lt;b&gt;x&lt;/b&gt;');
  });

  test('intraword underscore never italicizes (latin + cyrillic)', () => {
    expect(mdToTelegramHtml('log_meal')).toBe('log_meal');
    expect(mdToTelegramHtml('red_flag_events')).toBe('red_flag_events');
    expect(mdToTelegramHtml('лог_еды_тест')).toBe('лог_еды_тест');
  });

  test('unpaired markers stay literal', () => {
    expect(mdToTelegramHtml('a ** b')).toBe('a ** b');
    expect(mdToTelegramHtml('a **b')).toBe('a **b');
    expect(mdToTelegramHtml('*one')).toBe('*one');
  });

  test('space-flanked asterisk stays literal (multiplication)', () => {
    expect(mdToTelegramHtml('2 * 3')).toBe('2 * 3');
  });

  test('nests bold and italic', () => {
    expect(mdToTelegramHtml('**bold _it_**')).toBe('<b>bold <i>it</i></b>');
  });

  test('same-precedence scanning continues past the first pair', () => {
    expect(mdToTelegramHtml('**a** and **b**')).toBe('<b>a</b> and <b>b</b>');
  });

  test('crossing delimiters resolve by precedence, never interleave', () => {
    expect(mdToTelegramHtml('**a *b** c*')).toBe('<b>a *b</b> c*');
  });

  test('multi-line input joins lines back with newlines', () => {
    expect(mdToTelegramHtml('a\n\nb')).toBe('a\n\nb');
  });
});

describe('mdToTelegramHtml — code spans and links (strict)', () => {
  test('renders inline code', () => {
    expect(mdToTelegramHtml('`code`')).toBe('<code>code</code>');
  });

  test('code content is opaque — markers inside never format', () => {
    expect(mdToTelegramHtml('`a ** b`')).toBe('<code>a ** b</code>');
  });

  test('code content is escaped', () => {
    expect(mdToTelegramHtml('`<x>&`')).toBe('<code>&lt;x&gt;&amp;</code>');
  });

  test('a lone backtick stays literal and the rest still formats', () => {
    expect(mdToTelegramHtml('a ` b **c**')).toBe('a ` b <b>c</b>');
  });

  test('an empty code span stays literal', () => {
    expect(mdToTelegramHtml('a `` b')).toBe('a `` b');
  });

  test('renders a complete http(s) link', () => {
    expect(mdToTelegramHtml('[текст](https://example.com/path)')).toBe(
      '<a href="https://example.com/path">текст</a>',
    );
  });

  test('escapes & in the href exactly once', () => {
    expect(mdToTelegramHtml('[x](https://e.test/?a=1&b=2)')).toBe(
      '<a href="https://e.test/?a=1&amp;b=2">x</a>',
    );
  });

  test('marker characters inside the href are never rescanned', () => {
    expect(mdToTelegramHtml('[x](https://e.test/_a_*b*)')).toBe(
      '<a href="https://e.test/_a_*b*">x</a>',
    );
  });

  test('link text still formats', () => {
    expect(mdToTelegramHtml('[**x**](https://e.test/)')).toBe(
      '<a href="https://e.test/"><b>x</b></a>',
    );
  });

  test('non-http(s) schemes stay literal', () => {
    expect(mdToTelegramHtml('[x](ftp://e.test)')).toBe('[x](ftp://e.test)');
  });

  test('an incomplete link stays literal', () => {
    expect(mdToTelegramHtml('[x](https://e.te')).toBe('[x](https://e.te');
  });

  test('renders two links on one line (scan continues past the first)', () => {
    expect(
      mdToTelegramHtml('[a](https://e.test/x) [b](https://e.test/y)'),
    ).toBe('<a href="https://e.test/x">a</a> <a href="https://e.test/y">b</a>');
  });

  test('a bracket not followed by ( is skipped, later marks still format', () => {
    // matchLink skip-and-continue: `]` not followed by `(` → keep scanning.
    expect(mdToTelegramHtml('[abc] **x**')).toBe('[abc] <b>x</b>');
  });

  test('a bracket with no closing ] short-circuits the scan', () => {
    // matchLink early-out: no `]` ahead → return null, marks still format.
    expect(mdToTelegramHtml('[abc **x**')).toBe('[abc <b>x</b>');
  });

  test('a bad-scheme candidate is skipped, a later valid link matches', () => {
    expect(mdToTelegramHtml('[a](ftp://x) [b](https://e.test/)')).toBe(
      '[a](ftp://x) <a href="https://e.test/">b</a>',
    );
  });
});

describe('mdToTelegramHtml — block rules (strict)', () => {
  test('renders a heading as a bold line', () => {
    expect(mdToTelegramHtml('## Итог дня')).toBe('<b>Итог дня</b>');
  });

  test('a #hashtag without a space is not a heading', () => {
    expect(mdToTelegramHtml('#tag')).toBe('#tag');
  });

  test('renders bullets as • keeping the indent', () => {
    expect(mdToTelegramHtml('- пункт')).toBe('• пункт');
    expect(mdToTelegramHtml('* пункт')).toBe('• пункт');
    expect(mdToTelegramHtml('  - вложенный')).toBe('  • вложенный');
  });

  test('bullet content still formats inline', () => {
    expect(mdToTelegramHtml('- **жирный** пункт')).toBe(
      '• <b>жирный</b> пункт',
    );
  });

  test('numbered lists pass through', () => {
    expect(mdToTelegramHtml('1. пункт')).toBe('1. пункт');
  });

  test('renders > quoted as blockquote (parse-on-raw regression pin)', () => {
    expect(mdToTelegramHtml('> цитата')).toBe(
      '<blockquote>цитата</blockquote>',
    );
  });

  test('merges consecutive quoted lines into one blockquote', () => {
    expect(mdToTelegramHtml('> а\n> б')).toBe('<blockquote>а\nб</blockquote>');
  });

  test('a bare > with no content stays literal (no empty blockquote tag)', () => {
    // Telegram rejects an empty <blockquote></blockquote>; the bare marker
    // must round-trip as escaped literal text instead.
    expect(mdToTelegramHtml('>')).toBe('&gt;');
    expect(mdToTelegramHtml('> ')).toBe('&gt; '); // trailing space kept literal
    expect(mdToTelegramHtml('>\n>')).toBe('&gt;\n&gt;');
  });

  test('a quote run keeps the blockquote when any line has content', () => {
    expect(mdToTelegramHtml('> а\n>\n> б')).toBe(
      '<blockquote>а\n\nб</blockquote>',
    );
  });

  test('a heading whose content is bold nests the tags (accepted)', () => {
    // The heading wrapper <b>…</b> plus inline-rendered bold nest; Telegram
    // tolerates duplicate nesting and still renders bold. Pin the behavior.
    expect(mdToTelegramHtml('## **Итог дня**')).toBe('<b><b>Итог дня</b></b>');
  });

  test('a heading with a code span splits the bold around the code', () => {
    // Telegram rejects a code entity nested in bold (tdlib: "Pre and Code
    // can't be part of other entities, except blockquote"), so the heading
    // bold must NOT wrap the <code> — it splits around it.
    expect(mdToTelegramHtml('## See `foo` now')).toBe(
      '<b>See </b><code>foo</code><b> now</b>',
    );
    // Heading that is entirely a code span emits no bold at all.
    expect(mdToTelegramHtml('## `foo`')).toBe('<code>foo</code>');
    // Trailing code span: no empty <b></b> after it.
    expect(mdToTelegramHtml('## run `foo`')).toBe(
      '<b>run </b><code>foo</code>',
    );
  });

  test('a blockquote with a code span keeps code (blockquote is the exception)', () => {
    // tdlib explicitly allows Code/Pre to be part of a blockquote, so this
    // nesting is valid and must NOT be split or stripped.
    expect(mdToTelegramHtml('> `x`')).toBe(
      '<blockquote><code>x</code></blockquote>',
    );
  });

  test('tables and horizontal rules pass through literally', () => {
    expect(mdToTelegramHtml('| a | b |')).toBe('| a | b |');
    expect(mdToTelegramHtml('---')).toBe('---');
  });
});

describe('mdToTelegramHtml — fences (strict)', () => {
  test('renders a fenced block with a language class', () => {
    expect(mdToTelegramHtml('```ts\nconst a = 1;\n```')).toBe(
      '<pre><code class="language-ts">const a = 1;</code></pre>',
    );
  });

  test('renders a bare fenced block as <pre>', () => {
    expect(mdToTelegramHtml('```\nx\n```')).toBe('<pre>x</pre>');
  });

  test('fence content is escaped but never transformed', () => {
    expect(mdToTelegramHtml('```\n**not bold** <x>\n```')).toBe(
      '<pre>**not bold** &lt;x&gt;</pre>',
    );
  });

  test('sanitizes the info string — first token, allowlisted', () => {
    expect(mdToTelegramHtml('```ts title="x"\ncode\n```')).toBe(
      '<pre><code class="language-ts">code</code></pre>',
    );
    expect(mdToTelegramHtml('```foo">\ncode\n```')).toBe('<pre>code</pre>');
  });

  test('supports tilde fences', () => {
    expect(mdToTelegramHtml('~~~\nx\n~~~')).toBe('<pre>x</pre>');
  });

  test('an unclosed strict fence is opaque literal to EOT', () => {
    expect(mdToTelegramHtml('```\nconst x = **y**;')).toBe(
      '```\nconst x = **y**;',
    );
  });
});

describe('mdToTelegramHtml — unclosed constructs stay literal', () => {
  // Every unpaired marker is emitted verbatim: the renderer never invents a
  // closing tag, so a mid-stream chunk can only ever under-format, never
  // mangle. (Telegram renders the live draft itself from the raw text the
  // draft streamer pushes, so there is no partial-HTML path to serve.)
  test('an unclosed bold stays literal', () => {
    expect(mdToTelegramHtml('**овсянка на во')).toBe('**овсянка на во');
  });

  test('a bare trailing marker stays literal', () => {
    expect(mdToTelegramHtml('итог **')).toBe('итог **');
  });

  test('an unclosed code span stays literal', () => {
    expect(mdToTelegramHtml('см `query_log')).toBe('см `query_log');
  });

  test('unclosed marks stay literal across every marker family', () => {
    expect(mdToTelegramHtml('~~зач')).toBe('~~зач');
    expect(mdToTelegramHtml('__жир')).toBe('__жир');
    expect(mdToTelegramHtml('_курс')).toBe('_курс');
    expect(mdToTelegramHtml('*курс')).toBe('*курс');
  });

  test('an incomplete link stays literal', () => {
    expect(mdToTelegramHtml('[x](https://e')).toBe('[x](https://e');
  });

  test('a bare trailing backtick stays literal', () => {
    expect(mdToTelegramHtml('см `')).toBe('см `');
  });

  test('an unclosed mark inside a blockquote stays literal', () => {
    expect(mdToTelegramHtml('> **bold')).toBe(
      '<blockquote>**bold</blockquote>',
    );
  });

  test('a lone-surrogate tail after an unpaired marker never throws', () => {
    expect(() => mdToTelegramHtml('**ab\uD83D')).not.toThrow();
  });
});

describe('mdToTelegramHtml — plain-text passthrough (no markers → byte-identical)', () => {
  // Local fixtures replacing the original emergency-reply passthrough test
  // (which imported health-agent code). Same intent: text with no markdown
  // markers round-trips byte-identical (no tags, no escapes).
  test('plain multi-line text round-trips unchanged', () => {
    const fixtures = [
      'Похоже на симптомы, требующие врача. Позвони 103.',
      'Если боль в груди — вызови скорую (103) немедленно.',
      'Перекосило лицо или речь — это может быть инсульт. 103 сейчас.',
      'Признаки анафилаксии — звони 103.\nЕсли есть автоинъектор адреналина, используй его.',
    ];
    for (const text of fixtures) {
      expect(mdToTelegramHtml(text)).toBe(text); // no markers → byte-identical
    }
  });
});

describe('mdToTelegramHtml — totality and review pins', () => {
  test('closer-side intraword guard holds (_a_b stays literal)', () => {
    expect(mdToTelegramHtml('_a_b')).toBe('_a_b');
  });

  test('marks never pair across a newline', () => {
    expect(mdToTelegramHtml('**a\nb**')).toBe('**a\nb**');
  });

  test('an unclosed strict fence with a language is opaque too', () => {
    expect(mdToTelegramHtml('```ts\nx = **y**;')).toBe('```ts\nx = **y**;');
  });

  const nasty = [
    '*'.repeat(5000),
    '_'.repeat(5000),
    '`'.repeat(5001),
    '**a '.repeat(1000),
    `${'['.repeat(1000)}${'('.repeat(1000)}`,
    '\uD83D**emoji bold**\uDE00',
    '',
  ];
  test('never throws on pathological inputs', () => {
    for (const input of nasty) {
      expect(() => mdToTelegramHtml(input)).not.toThrow();
      expect(typeof mdToTelegramHtml(input)).toBe('string');
    }
  });

  test('bracket spam scans in linear time (regression pin for the indexOf scan)', () => {
    const start = performance.now();
    mdToTelegramHtml('['.repeat(20000));
    mdToTelegramHtml('[x]('.repeat(5000));
    const elapsed = performance.now() - start;
    // The old backtracking regex took ~150ms+ on these; the index-based
    // scan is sub-millisecond. 50ms is a generous CI-safe ceiling.
    expect(elapsed).toBeLessThan(50);
  });
});
