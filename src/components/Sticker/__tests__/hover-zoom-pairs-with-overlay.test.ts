import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The card's hover zoom and the sticker overlay move together, or stickers drift.
 *
 * A placed sticker sits on an overlay that is a SIBLING of the card's link — it
 * has to paint above the media and must not join the click target — so it does
 * not inherit the transform the media gets on hover. The two are kept in step by
 * one rule listing both. Retune the media's zoom alone and every sticker slides
 * off its spot for as long as the pointer is on the card.
 *
 * 🔴 WHY THIS IS A SOURCE SCAN AND NOT A RENDER. `:hover` is not a state a
 * component test drives, and the component harness mounts without the app's
 * stylesheet — so `CardStickerOverlay.browser.test.tsx` positions its fixture
 * media by hand and could never notice a stylesheet change. An adversarial
 * review of the hover fix found exactly that: nothing in the suite could fail if
 * the pairing broke.
 *
 * 🔴 AND WHY IT ALSO CHECKS THE HEIGHT. What makes one transform correct for two
 * elements is a SHARED CENTRE, not equal boxes. `EdgeMedia` puts `.responsive`
 * (`height: auto`) on the same element as `.image` (`height: 100%`), same
 * specificity, same layer — so without `!important` the winner is chunk order.
 * Lose that tie and the media box is shorter than the card, the centres
 * separate, and the hover rule starts causing the drift it exists to remove.
 */
const STYLESHEET = resolve(
  __dirname,
  '..',
  '..',
  'CardTemplates',
  'AspectRatioImageCard.module.scss'
);

const source = () => readFileSync(STYLESHEET, 'utf-8');

/** The `&:hover { … }` block inside `.linkOrClick`, braces balanced. */
const hoverBlock = (css: string) => {
  const start = css.indexOf('&:hover');
  if (start < 0) return null;

  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (!depth) return css.slice(start, i + 1);
    }
  }
  return null;
};

/** Every `transform: …;` value in a block, in order. */
const transformsIn = (css: string) =>
  Array.from(css.matchAll(/transform:\s*([^;]+);/g), (match) => match[1].trim());

describe('the hover zoom carries the sticker overlay with it', () => {
  test('the hover block scales the media and the overlay by the same transform', () => {
    const block = hoverBlock(source());

    // The positive control: if the block cannot be found at all — renamed,
    // restructured, moved to another file — that is a failure, not a pass. Every
    // assertion below is vacuously true against `null`.
    expect(block).not.toBeNull();
    expect(block).toContain('.image');
    expect(block).toContain('[data-sticker-overlay]');

    const transforms = transformsIn(block ?? '');

    // Two rules, one value. A retune that touches only the media leaves two
    // different values here and fails on this line.
    expect(transforms).toHaveLength(2);
    expect(new Set(transforms).size).toBe(1);
  });

  test('the media height is pinned, so the two keep a common centre', () => {
    expect(source()).toMatch(/height:\s*100%\s*!important/);
  });

  test('the overlay transitions with the media rather than snapping', () => {
    const css = source();

    const mediaTransition = /transition:\s*transform\s+400ms\s+ease/.test(css);
    const overlayTransition =
      /:global\(\[data-sticker-overlay\]\)\s*\{[^}]*transition:\s*transform\s+400ms\s+ease/.test(
        css
      );

    expect(mediaTransition).toBe(true);
    expect(overlayTransition).toBe(true);
  });
});
