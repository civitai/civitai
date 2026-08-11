import { describe, expect, it } from 'vitest';
import {
  CARD_TREATMENT_FALLBACK,
  resolveTreatment,
  STICKER_TREATMENT_KEYS,
  STICKER_TREATMENTS,
  type StickerTreatmentKey,
} from '~/components/Sticker/treatments/sticker-treatments';

const styleText = (key: StickerTreatmentKey) => {
  const treatment = STICKER_TREATMENTS[key];
  return JSON.stringify([
    treatment.imageStyle ?? null,
    treatment.behind ?? null,
    treatment.animationClassName ?? null,
  ]).toLowerCase();
};

describe('sticker treatments', () => {
  // Pending placements are 60% opacity plus a dashed yellow outline. A treatment
  // that borrows any of that tells an owner they have a decision waiting when
  // they do not. The rule is enforced over the whole table rather than over the
  // options that exist today, because the violation arrives with a sixth option
  // written by someone who never read the comment above the fifth.
  it.each(STICKER_TREATMENT_KEYS)('%s does not borrow the pending treatment', (key) => {
    const text = styleText(key);

    expect(text).not.toContain('opacity');
    expect(text).not.toContain('dashed');
    expect(text).not.toContain('yellow');
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
      STICKER_TREATMENTS[CARD_TREATMENT_FALLBACK]
    );
    expect(resolveTreatment({ treatment: 'motion', surface: 'detail', isPending: false })).toBe(
      STICKER_TREATMENTS.motion
    );
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
