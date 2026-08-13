import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolveTreatment,
  STICKER_TREATMENT_KEYS,
  STICKER_TREATMENTS,
  STILL_STICKER_TREATMENT,
  type StickerTreatmentKey,
} from '~/components/Sticker/treatments/sticker-treatments';

const BORROWED = ['opacity', 'dashed', 'yellow'];

const styleText = (key: StickerTreatmentKey) => {
  const treatment = STICKER_TREATMENTS[key];
  return JSON.stringify([treatment.imageStyle ?? null, treatment.behind ?? null]).toLowerCase();
};

/**
 * The stylesheet, read as source.
 *
 * `animationClassName` is a CSS-module hash — serialising it yields
 * `...module__0zsX9W__motion` and never the rules behind it, so a treatment can
 * put the whole pending look in a class and satisfy an inline-style check. That
 * escape hatch is not hypothetical: `motion` already uses a class, so a sixth
 * option copying its shape is the likely path to violating this.
 */
const stylesheet = readFileSync(
  join(__dirname, '..', 'sticker-treatments.module.scss'),
  'utf-8'
).toLowerCase();

describe('sticker treatments', () => {
  // Pending placements are a dashed yellow outline. A treatment
  // that borrows any of that tells an owner they have a decision waiting when
  // they do not. The rule is enforced over the whole table rather than over the
  // options that exist today, because the violation arrives with a sixth option
  // written by someone who never read the comment above the fifth.
  it.each(STICKER_TREATMENT_KEYS)('%s does not borrow the pending treatment inline', (key) => {
    const text = styleText(key);

    for (const borrowed of BORROWED) expect(text).not.toContain(borrowed);
  });

  // The other half of the same rule. Grepping the whole stylesheet rather than
  // one class: the file exists only to hold treatment animations, so anything
  // in it is reachable by some treatment, and scoping the check to the classes
  // currently referenced would leave the next one uncovered until someone
  // remembered to add it here.
  it('does not borrow the pending treatment from the stylesheet either', () => {
    for (const borrowed of BORROWED) expect(stylesheet).not.toContain(borrowed);
  });

  // What the pair above does NOT cover, stated plainly so a green run is not
  // over-read. A treatment could still reach the pending look through:
  //   - a Tailwind class in `behind.className` (`opacity-60`, `border-dashed`)
  //   - a design token that does not contain the literal strings above
  //   - a stylesheet other than this one
  // The class name cannot be used to rule the last one out: under vitest the
  // CSS-module hash is `_motion_aa116f`, with no trace of the file it came
  // from, so an assertion on it would encode the bundler's naming rather than
  // anything about the styles. These tests close the paths a treatment is
  // actually written along today; they do not close the space.

  // `transform` belongs to the placer, not to a treatment: the flip is written
  // as `scaleX(-1)` on the artwork and is spread AFTER `imageStyle`, so a
  // treatment that set one would have it silently dropped on an unflipped
  // sticker and silently drop the flip on a flipped one. Same argument as the
  // pending-look guard above, and the same failure mode — it arrives with a
  // sixth option written by someone who never read this file.
  it.each(STICKER_TREATMENT_KEYS)('%s leaves transform to the placer', (key) => {
    expect(styleText(key)).not.toContain('transform');
  });

  it('covers every declared key, so the table cannot drift from the union', () => {
    expect(Object.keys(STICKER_TREATMENTS).sort()).toEqual([...STICKER_TREATMENT_KEYS].sort());
  });

  it('gives a pending placement no treatment on either surface', () => {
    for (const surface of ['detail', 'card'] as const)
      for (const treatment of STICKER_TREATMENT_KEYS)
        expect(resolveTreatment({ treatment, surface, isPending: true })).toBe(
          STICKER_TREATMENTS.none
        );
  });

  it('drops an animating treatment to the static fallback on a card', () => {
    expect(resolveTreatment({ treatment: 'motion', surface: 'card', isPending: false })).toBe(
      STICKER_TREATMENTS[STILL_STICKER_TREATMENT]
    );
    expect(resolveTreatment({ treatment: 'motion', surface: 'detail', isPending: false })).toBe(
      STICKER_TREATMENTS.motion
    );
  });

  // One constant carries both the card fallback and the motion opt-out.
  // Asserting `resolveTreatment` against it is self-referential — it holds even
  // if the constant is `motion`, which would make the opt-out a no-op AND animate
  // every card in a feed. Pin the literal, and pin that it does not animate.
  it('falls back to a treatment that is still, not to another animating one', () => {
    expect(STILL_STICKER_TREATMENT).toBe('lift');
    expect(STICKER_TREATMENTS[STILL_STICKER_TREATMENT].animationClassName).toBeUndefined();
  });

  it('leaves a non-animating treatment alone on a card', () => {
    expect(resolveTreatment({ treatment: 'dieCut', surface: 'card', isPending: false })).toBe(
      STICKER_TREATMENTS.dieCut
    );
  });

  // The plate is the only option that paints its own background, and it is the
  // only one that can lose its effect silently: this repo has no browserslist,
  // so autoprefixer adds nothing and an unprefixed backdrop-filter is dropped
  // whole on iOS 17 and below.
  it('ships the plate blur prefixed', () => {
    const style = STICKER_TREATMENTS.plate.behind?.style ?? {};

    expect(style.backdropFilter).toBeTruthy();
    expect(style.WebkitBackdropFilter).toBe(style.backdropFilter);
  });
});
