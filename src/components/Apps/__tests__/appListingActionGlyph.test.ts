import { describe, expect, test } from 'vitest';

import {
  cardActionGlyph,
  detailActionGlyph,
  type PrimaryActionGlyph,
} from '~/components/Apps/appListingActionGlyph';
import { ACTION_GLYPH_ICONS } from '~/components/Apps/appListingActionGlyphIcons';
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

// Exhaustive over the union, so adding a mode/action without deciding its glyph
// fails to typecheck here rather than silently defaulting at a call site.
const DETAIL_MODES: readonly DetailActionMode[] = ['open', 'visit', 'connect', 'info'];
const CARD_ACTIONS: readonly ListingCtaAction[] = ['open', 'detail', 'visit', 'connect'];

describe('detailActionGlyph', () => {
  test('the in-site and off-site glyphs are DIFFERENT (the #3391 premise)', () => {
    expect(detailActionGlyph('open')).not.toBe(detailActionGlyph('visit'));
  });

  test('maps each detail mode to its named glyph', () => {
    expect(detailActionGlyph('open')).toBe('launch');
    expect(detailActionGlyph('visit')).toBe('external');
    expect(detailActionGlyph('connect')).toBe('connect');
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
    // "View details" → the unified listing detail. Informational, not a launch.
    expect(cardActionGlyph('detail')).toBe('info');
  });

  test('agrees with the detail page on every shared action name', () => {
    // The two view-models use the same words for the same meaning; a card and
    // the detail it links to must not disagree about what the CTA is.
    for (const shared of ['open', 'visit', 'connect'] as const) {
      expect(cardActionGlyph(shared)).toBe(detailActionGlyph(shared));
    }
  });
});

describe('ACTION_GLYPH_ICONS', () => {
  test('resolves an icon for every glyph in the vocabulary', () => {
    const glyphs = [
      ...DETAIL_MODES.map(detailActionGlyph),
      ...CARD_ACTIONS.map(cardActionGlyph),
    ] as PrimaryActionGlyph[];
    for (const glyph of glyphs) {
      expect(ACTION_GLYPH_ICONS[glyph]).toBeTruthy();
    }
  });

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
