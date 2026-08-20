import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stripComments } from '../../../../test/strip-comments';

/**
 * Every sticker hover card opens on the SAME delay, and that delay is a constant.
 *
 * Three of these were tuned separately — the placed sticker at 300ms, the shop
 * shelf at 200ms, the chat attribution card on `HOVER_DELAY_MS` — and the two
 * literals were both reported as opening too fast. The shop one was reported
 * after the placed one had already been "fixed", because a number written at a
 * call site is invisible to anyone changing the other call site.
 *
 * 🔴 WHAT THIS CATCHES THAT THE BROWSER TESTS DO NOT. `StickerPlacementHoverCard`
 * has a test that measures its open delay, and it stays green while a NEW card
 * ships next to it on a hand-written 150. This is the only check that sees a
 * surface nobody wrote a test for, which is exactly how the shop shelf got its
 * own number.
 *
 * It reads source text rather than rendering, so it costs nothing and covers
 * files that have no test harness at all. Comments are stripped first: this file
 * discusses `openDelay={200}` at length, and so do the components.
 */
const STICKER_DIR = resolve(__dirname, '..');

const componentFiles = () =>
  readdirSync(STICKER_DIR)
    .filter((name) => name.endsWith('.tsx') && !name.includes('.test.'))
    .map((name) => ({
      name,
      source: stripComments(readFileSync(join(STICKER_DIR, name), 'utf-8')),
    }));

/** `openDelay={…}` and whatever is inside the braces, per file. */
const OPEN_DELAY = /openDelay=\{([^}]*)\}/g;

describe('sticker hover cards share one open delay', () => {
  test('no call site writes its own number', () => {
    const literals: string[] = [];

    for (const { name, source } of componentFiles())
      for (const [, value] of source.matchAll(OPEN_DELAY))
        if (value.trim() !== 'HOVER_DELAY_MS')
          literals.push(`${name}: openDelay={${value.trim()}}`);

    expect(literals).toEqual([]);
  });

  /**
   * The positive control, and it is not decoration: the assertion above passes
   * for free against zero matches, so a rename of the prop — or a move of these
   * components to another directory — would leave it green forever while every
   * card drifted apart again.
   */
  test('the scan actually found the call sites it is guarding', () => {
    const found = componentFiles().flatMap(({ name, source }) =>
      Array.from(source.matchAll(OPEN_DELAY), () => name)
    );

    expect(found.length).toBeGreaterThanOrEqual(2);
    expect(found).toContain('StickerPlacementHoverCard.tsx');
    expect(found).toContain('StickerShopPanel.tsx');
  });
});
