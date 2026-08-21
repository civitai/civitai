import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { stripComments } from '../../../../test/strip-comments';

/**
 * Every sticker hover card opens on the SAME delay, and takes it from the shared
 * constant rather than writing a number.
 *
 * Three of these were tuned separately — the placed sticker at 300ms, the shop
 * shelf at 200ms, the chat attribution card on `HOVER_DELAY_MS` — and both
 * literals were reported as opening too fast. The shop one was reported AFTER
 * the placed one had been "fixed", because a number at one call site is
 * invisible to whoever is changing the other.
 *
 * 🔴 WHAT THIS CATCHES THAT THE BROWSER TESTS DO NOT. `StickerPlacementHoverCard`
 * has a test that measures its own open delay, and it stays green while a new
 * card ships beside it on a hand-written 150. This is the check that sees a
 * surface nobody wrote a test for.
 *
 * 🔴 TWO SPELLINGS, NOT ONE. A card here either passes `openDelay` to Mantine or
 * hand-rolls a `setTimeout` — the attribution card does the latter, because a
 * chat sticker is built inside `dangerouslySetInnerHTML` and has no React node
 * to wrap. An earlier version of this file scanned only the prop, named the
 * attribution card in its own docstring, and would have stayed green with that
 * timer edited to 150. Both spellings are checked now.
 *
 * 🔴 AND IT CHECKS THE IMPORT, NOT THE TOKEN. Matching the name `HOVER_DELAY_MS`
 * alone passes for a file that declares its own `const HOVER_DELAY_MS = 200`,
 * which is exactly what copying the pattern without noticing the constants
 * module produces.
 *
 * ⚠️ WHAT IT DOES NOT COVER, stated because a silent gap is worse than a narrow
 * scope: a hover card for stickers living OUTSIDE `src/components/Sticker`
 * (`Sticker.tsx` renders through `RenderHtml`, whose card is the attribution one
 * covered here, but a future card mounted from elsewhere would be invisible);
 * and a delay arriving through a spread props object or a Mantine theme
 * `defaultProps`, neither of which is a static call site this can read.
 */
const STICKER_DIR = resolve(__dirname, '..');
/**
 * Both paths to the one constant. `UserHoverCard` re-exports it, and the
 * attribution card reads it from there because it takes four other names from
 * that module in the same import — identity holds through a re-export, so
 * forcing a second import line would be noise, not safety.
 */
const SHARED_SOURCES = [
  '~/components/UserAvatar/hover-card.constants',
  '~/components/UserAvatar/UserHoverCard',
];
const SHARED = 'HOVER_DELAY_MS';

/** Every component file under the sticker directory, subdirectories included. */
const componentFiles = (dir = STICKER_DIR): { name: string; source: string }[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    // `__tests__` holds this file, which discusses every pattern it forbids.
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : componentFiles(full);
    if (!entry.name.endsWith('.tsx') && !entry.name.endsWith('.ts')) return [];
    if (entry.name.includes('.test.')) return [];
    return [
      {
        name: relative(STICKER_DIR, full).split(sep).join('/'),
        source: stripComments(readFileSync(full, 'utf-8')),
      },
    ];
  });

/**
 * `openDelay={…}`, but only on a hover card.
 *
 * Scoped by the element it sits on rather than by the prop name alone: `Tooltip`
 * takes an `openDelay` too, and a tooltip is aimed at, not swept across. Left
 * unscoped, the first `<Tooltip openDelay={300}>` anyone adds in this directory
 * turns this red and pressures a tooltip onto a hover-card constant.
 */
const HOVER_CARD_OPEN_DELAY = /<HoverCard\b[^>]*?\bopenDelay=\{([^}]*)\}/gs;

/** A hand-rolled open timer: `setTimeout(…, <delay>)` closing an open handler. */
const HAND_ROLLED_DELAY = /openTimer\.current = setTimeout\([\s\S]*?,\s*([A-Za-z0-9_]+)\s*\)/
  .source;

/**
 * Every open delay a file states, in both spellings. Fresh regexes per call —
 * a `g` regex carries `lastIndex` between uses, and a shared one silently skips
 * matches on the second file it is pointed at.
 */
const delaysIn = (source: string) =>
  [
    ...Array.from(source.matchAll(new RegExp(HOVER_CARD_OPEN_DELAY, 'gs')), (m) => m[1]),
    ...Array.from(source.matchAll(new RegExp(HAND_ROLLED_DELAY, 'g')), (m) => m[1]),
  ].map((value) => value.trim());

const offenders = () => {
  const found: string[] = [];

  for (const { name, source } of componentFiles()) {
    const delays = delaysIn(source);
    if (!delays.length) continue;

    for (const value of delays)
      if (value !== SHARED) found.push(`${name}: opens on ${value}, not ${SHARED}`);

    // Identity, not spelling. A local `const HOVER_DELAY_MS = 200` reads
    // identically at the call site and opens on 200.
    if (delays.includes(SHARED) && !SHARED_SOURCES.some((path) => source.includes(path)))
      found.push(`${name}: uses ${SHARED} without importing it from ${SHARED_SOURCES[0]}`);
  }

  return found;
};

describe('sticker hover cards share one open delay', () => {
  test('no card writes its own number, or its own copy of the constant', () => {
    expect(offenders()).toEqual([]);
  });

  /**
   * The positive control, and it is load-bearing twice over: the assertion above
   * passes for free against zero matches, so a prop rename or a directory move
   * would leave it green forever — and naming the three files means a card that
   * stops being scanned is a failure rather than a silent gap.
   */
  test('the scan still finds all three cards it is guarding', () => {
    const scanned = componentFiles()
      .filter(({ source }) => delaysIn(source).length > 0)
      .map(({ name }) => name)
      .sort();

    expect(scanned).toEqual([
      'StickerAttributionHoverCard.tsx',
      'StickerPlacementHoverCard.tsx',
      'StickerShopPanel.tsx',
    ]);
  });
});
