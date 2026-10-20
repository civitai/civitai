import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Only dark, gray, yellow, green, blue, red, orange, lime and gold carry Mantine-style 0-9 shades
 * in the Tailwind config; every other hue has Tailwind's 50-950. So `bg-violet-6` compiles to
 * nothing and the element silently loses its colour (the storyline chip once rendered with no
 * fill). Use Mantine's variable instead: `bg-[var(--mantine-color-violet-6)]`.
 */
const MISSING_SCALES = ['violet', 'teal', 'indigo', 'purple', 'pink', 'cyan', 'grape'];
const pattern = new RegExp(
  String.raw`(?:^|[\s"'\x60:])(?:bg|text|border|ring|from|to|via|fill|stroke)-(?:` +
    MISSING_SCALES.join('|') +
    String.raw`)-\d(?!\d)`,
  'm'
);

const dir = join(__dirname, '..');
const sources = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(
  (f) => f.endsWith('.tsx') && !f.includes('__tests__')
);

describe('storyline components use only Tailwind colour shades that exist', () => {
  it('reads the component sources', () => {
    expect(sources.length).toBeGreaterThan(10);
  });

  it('has no Mantine-style shade on a hue the Tailwind config gives only 50-950', () => {
    const offenders = sources.filter((f) => pattern.test(readFileSync(join(dir, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('would catch one, and passes the working spellings', () => {
    expect([
      pattern.test('className="bg-violet-6 p-2"'),
      pattern.test('dark:text-teal-3'),
      pattern.test('bg-[var(--mantine-color-violet-6)]'),
      pattern.test('from-indigo-500'),
      pattern.test('bg-lime-6'),
    ]).toEqual([true, true, false, false, false]);
  });
});
