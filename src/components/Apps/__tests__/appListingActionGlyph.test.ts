import { describe, expect, test } from 'vitest';

import {
  ACTION_GLYPH_ICONS,
  cardActionGlyph,
  detailActionGlyph,
} from '~/components/Apps/appListingActionGlyph';
import type { ListingCtaAction } from '~/components/Apps/appListingCardView';
import type { DetailActionMode } from '~/components/Apps/appListingDetailView';

/**
 * The invariant this file exists for: an app that RUNS HERE and an app that
 * SENDS YOU AWAY must not wear the same glyph.
 *
 * civitai #3391 removed the kind + category badges from the card and the detail
 * body on the stated grounds that the CTA already carried that signal. Measured
 * on prod it did not — both branches rendered `IconExternalLink`, differing only
 * in button copy. These assertions are the regression gate for that premise.
 */

// 🔴 GENUINELY exhaustive: `Record<DetailActionMode, true>` cannot be satisfied
// with a missing key, so adding a 5th mode fails to typecheck HERE. A plain
// `readonly DetailActionMode[]` would NOT — it accepts any subset, which would
// let the distinctness tests below silently under-cover a newly added mode.
// 🔴 `connect` is deliberately ABSENT (#4208 removed the mode). `satisfies` is
// exact both ways here: re-adding the key without re-adding the union member is
// an excess-property error, so this literal is also the tripwire for the dead
// Connect CTA coming back.
const DETAIL_MODES = Object.keys({
  open: true,
  visit: true,
  info: true,
} satisfies Record<DetailActionMode, true>) as DetailActionMode[];

const CARD_ACTIONS = Object.keys({
  open: true,
  detail: true,
  visit: true,
  connect: true,
} satisfies Record<ListingCtaAction, true>) as ListingCtaAction[];

describe('detailActionGlyph', () => {
  test('the in-site and off-site glyphs are DIFFERENT (the #3391 premise)', () => {
    expect(detailActionGlyph('open')).not.toBe(detailActionGlyph('visit'));
  });

  test('maps each detail mode to its named glyph', () => {
    expect(detailActionGlyph('open')).toBe('launch');
    expect(detailActionGlyph('visit')).toBe('external');
    expect(detailActionGlyph('info')).toBe('info');
  });

  test('every detail mode gets a distinct glyph', () => {
    const glyphs = DETAIL_MODES.map(detailActionGlyph);
    expect(new Set(glyphs).size).toBe(DETAIL_MODES.length);
  });
});

describe('cardActionGlyph', () => {
  test('the in-site and off-site glyphs are DIFFERENT', () => {
    expect(cardActionGlyph('open')).not.toBe(cardActionGlyph('visit'));
  });

  test('maps each card action to its named glyph', () => {
    expect(cardActionGlyph('open')).toBe('launch');
    expect(cardActionGlyph('visit')).toBe('external');
    expect(cardActionGlyph('connect')).toBe('connect');
    // 🔴 "View details" → `view` (IconEye), NOT `info`. This arm shipped as `info`
    // in #3540 while it had no caller, and #3539 had meanwhile shipped IconEye on
    // the card's real View-details CTA — so wiring the card to the module would
    // have silently repainted every one of them. Pinned to the value, and to the
    // DISTINCTION from `info`, so the two can't be collapsed again.
    expect(cardActionGlyph('detail')).toBe('view');
    expect(cardActionGlyph('detail')).not.toBe(detailActionGlyph('info'));
    expect(ACTION_GLYPH_ICONS.view).not.toBe(ACTION_GLYPH_ICONS.info);
  });

  test('every card action gets a distinct glyph', () => {
    const glyphs = CARD_ACTIONS.map(cardActionGlyph);
    expect(new Set(glyphs).size).toBe(CARD_ACTIONS.length);
  });

  test('agrees with the detail page on every shared action name', () => {
    // The two view-models use the same words for the same meaning; a card and
    // the detail it links to must not disagree about what the CTA is.
    //
    // 🔴 `connect` LEFT this list because it is no longer shared — #4208 removed
    // the detail mode, so `detailActionGlyph('connect')` does not type-check.
    // The set is derived, not hand-written, so it cannot silently under-cover:
    // it is every card action that is ALSO a detail mode.
    const shared = CARD_ACTIONS.filter((a): a is DetailActionMode =>
      (DETAIL_MODES as string[]).includes(a)
    );
    // Anti-vacuity: a filter that matched nothing would pass this loop trivially.
    expect(shared).toEqual(['open', 'visit']);
    for (const action of shared) {
      expect(cardActionGlyph(action), action).toBe(detailActionGlyph(action));
    }
  });
});

describe('ACTION_GLYPH_ICONS', () => {
  // NOTE: there is deliberately no "every glyph resolves to an icon" test here.
  // `Record<PrimaryActionGlyph, Icon>` already forbids a missing key, so such a
  // test cannot fail while the file typechecks — it would read as coverage while
  // asserting nothing.

  test('🔴 launch and external resolve to DIFFERENT icon components', () => {
    // The string-level assertions above only prove two glyph NAMES differ. This
    // is the one that proves the rendered SVG differs — mapping both names to
    // the same icon component would satisfy every other test in this file.
    expect(ACTION_GLYPH_ICONS.launch).not.toBe(ACTION_GLYPH_ICONS.external);
  });

  test('no two glyphs share an icon component', () => {
    const icons = Object.values(ACTION_GLYPH_ICONS);
    expect(new Set(icons).size).toBe(icons.length);
  });
});
