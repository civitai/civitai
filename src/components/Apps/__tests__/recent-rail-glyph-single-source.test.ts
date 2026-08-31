import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, test } from 'vitest';

import { IconExternalLink, IconEye, IconPlayerPlay } from '@tabler/icons-react';
import {
  ACTION_GLYPH_ICONS,
  cardActionGlyph,
  detailActionGlyph,
  recentRailActionGlyph,
} from '~/components/Apps/appListingActionGlyph';
import type { PrimaryActionGlyph } from '~/components/Apps/appListingActionGlyph';
import type { RecentRailAction } from '~/components/Apps/recentAppsRail';

/**
 * S6b — the primary-action glyph mapping is a SINGLE shared source, for all
 * THREE surfaces that render it.
 *
 * Before this, `appListingActionGlyph.ts` owned the mapping for the store card
 * (`cardActionGlyph`) and the listing detail (`detailActionGlyph`), while
 * `RecentlyOpenedApps.tsx` kept a private `RECENT_ACTION_ICONS` record for the
 * recents-rail tile — a third, drift-capable copy. `AppListingCard.tsx`'s CTA
 * comment named folding it in as the outstanding consolidation. This file is the
 * gate that keeps it folded in.
 *
 * ── HOW TO READ THE COVERAGE BELOW ─────────────────────────────────────────
 * The consolidation was PROVEN to be a pure refactor before it was made: the
 * private map's three entries resolved, BY REFERENCE, to the same Tabler
 * components `ACTION_GLYPH_ICONS` reaches via `launch`/`external`/`view`
 * (measured with a deliberately mis-mapped source as the positive control, so
 * the check was shown able to observe a disagreement — it reported exactly one
 * for the mutant and zero for the real source).
 *
 * A consequence of that: MOST of what follows is an INVARIANT GUARD, not
 * regression coverage. `recentRailActionGlyph` is new, so its value tests had no
 * pre-change code to go red against, and the icon-identity tests passed before
 * the change too (that is the whole point — nothing rendered differently). They
 * are pins against a FUTURE remap, and are labelled as such per test. The two
 * genuinely change-detecting tests are the structural ones in the last describe
 * block: they read the source and fail on the pre-change file.
 */

const APPS_DIR = path.resolve(__dirname, '..');

function read(file: string): string {
  return readFileSync(path.join(APPS_DIR, file), 'utf8');
}

// 🔴 GENUINELY exhaustive, the `satisfies Record<K, true>` idiom this repo's
// sibling `appListingActionGlyph.test.ts` established: a missing key fails to
// typecheck HERE, so adding a 4th `RecentRailAction` cannot silently escape the
// distinctness test below. A `readonly RecentRailAction[]` would accept a subset.
const RAIL_ACTIONS = Object.keys({
  open: true,
  visit: true,
  view: true,
} satisfies Record<RecentRailAction, true>) as RecentRailAction[];

describe('recentRailActionGlyph — the mapping itself', () => {
  test('INVARIANT GUARD: maps each rail action to its named glyph', () => {
    // Value-pinned to literals, NOT derived from the implementation. These are
    // the glyphs the rail shipped with before the fold-in, carried forward. The
    // `Record<…, PrimaryActionGlyph>` annotation makes a typo here a typecheck
    // failure rather than a confidently-wrong expectation.
    const expected: Record<RecentRailAction, PrimaryActionGlyph> = {
      open: 'launch',
      visit: 'external',
      view: 'view',
    };
    for (const action of RAIL_ACTIONS) {
      expect(recentRailActionGlyph(action)).toBe(expected[action]);
    }
  });

  test('INVARIANT GUARD: every rail action gets a DISTINCT glyph', () => {
    const glyphs = RAIL_ACTIONS.map(recentRailActionGlyph);
    expect(new Set(glyphs).size).toBe(RAIL_ACTIONS.length);
  });

  test('INVARIANT GUARD: the in-site and off-site glyphs are DIFFERENT (the #3391 premise)', () => {
    // Same invariant the card and the detail page are held to. On the rail it is
    // if anything sharper: the tile's glyph is the ONLY visual difference between
    // "re-opens here" and "leaves Civitai" — the accessible name is a tooltip.
    expect(recentRailActionGlyph('open')).not.toBe(recentRailActionGlyph('visit'));
    expect(ACTION_GLYPH_ICONS[recentRailActionGlyph('open')]).not.toBe(
      ACTION_GLYPH_ICONS[recentRailActionGlyph('visit')]
    );
  });

  test('INVARIANT GUARD: agrees with the card and the detail page on every shared action name', () => {
    // 'open' and 'visit' are spelled identically in all three vocabularies and
    // MUST resolve identically — a rail tile and the card it came from disagreeing
    // about what "open" looks like is exactly the drift this module prevents.
    for (const shared of ['open', 'visit'] as const) {
      expect(recentRailActionGlyph(shared)).toBe(cardActionGlyph(shared));
      expect(recentRailActionGlyph(shared)).toBe(detailActionGlyph(shared));
    }
    // The rail's 'view' is the card's 'detail' — same meaning, different word.
    expect(recentRailActionGlyph('view')).toBe(cardActionGlyph('detail'));
  });
});

describe('recents rail — the RENDERED icons are unchanged by the consolidation', () => {
  test('INVARIANT GUARD: each rail action resolves to the icon component it shipped with', () => {
    // 🔴 This is the "zero rendered change" pin. The three components on the
    // right are exactly what the deleted `RECENT_ACTION_ICONS` held, measured by
    // reference before the fold-in — not copied out of the new implementation.
    // It passed before the change and passes after; it exists to fail on a
    // FUTURE remap, and is not evidence that this change was correct.
    expect(ACTION_GLYPH_ICONS[recentRailActionGlyph('open')]).toBe(IconPlayerPlay);
    expect(ACTION_GLYPH_ICONS[recentRailActionGlyph('visit')]).toBe(IconExternalLink);
    expect(ACTION_GLYPH_ICONS[recentRailActionGlyph('view')]).toBe(IconEye);
  });

  test('CONTROL: the three pinned icon components are pairwise distinct', () => {
    // Without this, the identity assertions above could all hold while the rail
    // rendered one glyph for everything — the test would be green for the wrong
    // reason. Pins that the discriminator exists at all.
    const icons = [IconPlayerPlay, IconExternalLink, IconEye];
    expect(new Set(icons).size).toBe(3);
  });
});

describe('the private copy is GONE (structural — these fail on the pre-change source)', () => {
  test('RecentlyOpenedApps.tsx no longer declares RECENT_ACTION_ICONS', () => {
    const src = read('RecentlyOpenedApps.tsx');
    expect(src).not.toMatch(/const RECENT_ACTION_ICONS\b/);
  });

  test('RecentlyOpenedApps.tsx resolves the glyph through the shared module', () => {
    const src = read('RecentlyOpenedApps.tsx');
    expect(src).toMatch(/from '~\/components\/Apps\/appListingActionGlyph'/);
    // The exact read the tile performs — not merely "the identifier appears".
    expect(src).toMatch(/ACTION_GLYPH_ICONS\[recentRailActionGlyph\(action\)\]/);
    // 🔴 And it must not reach for raw Tabler icons to hand-roll a map again.
    // The file has no other use for them, so "imports no icons directly" is the
    // cleanest form of that guard — a re-added `RECENT_ACTION_ICONS` needs them.
    expect(src).not.toMatch(/from '@tabler\/icons-react'/);
  });

  test('appListingActionGlyph.ts exports the rail mapping with NO default arm', () => {
    const src = read('appListingActionGlyph.ts');
    expect(src).toMatch(/export function recentRailActionGlyph\b/);
    // 🔴 THE ENFORCEMENT. `Typecheck` is one of only two merge-blocking gates in
    // this repo (`Unit tests` is `continue-on-error`), so an exhaustive switch
    // returning a non-optional `PrimaryActionGlyph` is the ONLY mechanism that
    // turns "someone added a 4th RecentRailAction" into a build failure rather
    // than a tile that renders no glyph at all. A `default:` arm — or a `??`
    // fallback at the call site — would defeat it silently, which is precisely
    // why it is asserted structurally instead of trusted to review.
    const body = src.slice(src.indexOf('export function recentRailActionGlyph'));
    expect(body).not.toMatch(/\bdefault:/);
    expect(body).not.toMatch(/\?\?/);
  });
});
