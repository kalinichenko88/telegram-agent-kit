import { describe, expect, it } from 'vitest';
import { needsRich } from '../../src/format/rich.ts';

describe('needsRich', () => {
  it('is false for ordinary prose (so it routes to classic)', () => {
    expect(needsRich('Записал **запечённые куриные ножки**.\n≈341 ккал.')).toBe(
      false,
    );
    expect(needsRich('')).toBe(false);
    expect(needsRich('- a\n- b\n\n> quote\n\n`code` and [a](http://x)')).toBe(
      false,
    );
  });

  it('is true for a real GFM table, wherever the header row sits', () => {
    // Everything below the first two lines is a shape a block-first-line scan
    // misses — a lead-in line, a heading, a list, a closing fence, or a break
    // that isn't exactly '\n\n'. Classic has no table renderer, so a miss ships
    // literal pipes.
    expect(needsRich('| a | b |\n|---|---|\n| 1 | 2 |')).toBe(true);
    expect(needsRich('intro\n\n| a | b |\n|:-:|--:|\n| 1 | 2 |')).toBe(true);
    expect(needsRich('Итого:\n| a | b |\n|---|---|\n| 1 | 2 |')).toBe(true);
    expect(needsRich('## Report\n| a | b |\n|---|---|')).toBe(true);
    expect(needsRich('- a\n- b\n| a | b |\n|---|---|')).toBe(true);
    expect(needsRich('```\nx\n```\n| a | b |\n|---|---|')).toBe(true);
    expect(needsRich('intro\n\n\n| a | b |\n|---|---|')).toBe(true);
    expect(needsRich('intro\r\n\r\n| a | b |\r\n|---|---|')).toBe(true);
  });

  it('is false for pipes that are not a table', () => {
    expect(needsRich('a | b or c')).toBe(false);
    expect(needsRich('| stray | row |\n| another | row |')).toBe(false); // no delimiter
  });

  it('ignores tables inside code regions — classic renders those fine', () => {
    expect(needsRich('```\n| a | b |\n|---|---|\n```')).toBe(false);
    expect(needsRich('<pre>\n| a | b |\n|---|---|\n</pre>')).toBe(false);
    // ...but a real table AFTER the fence still counts.
    expect(
      needsRich('```\n| x |\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |'),
    ).toBe(true);
  });
});
