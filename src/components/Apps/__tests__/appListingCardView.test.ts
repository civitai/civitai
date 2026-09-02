import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  LISTING_ACTIONS_WIDEST_PX,
  LISTING_ACTION_ROW_GAP_PX,
  LISTING_ROLLUP_HIDE_BELOW_PX,
  LISTING_ROLLUP_MIN_WIDTH_PX,
  canOwnerEditListing,
  getListingBadge,
  getListingCta,
  getListingDetailHref,
  getOwnerEditHref,
  getRecommendLabel,
  isEditableListingStatus,
  listingRollupHideThreshold,
  safeExternalHref,
} from '~/components/Apps/appListingCardView';
import type {
  ListingCard,
  ListingRecommendRollup,
} from '~/server/schema/blocks/app-listing-read.schema';

/**
 * App Store Listings (W13) — P2b card view-model unit tests (node `unit`
 * project → the BLOCKING correctness gate; the browser component suites are
 * report-only). Pin the kind matrix, the recommend label (incl. null pct), the
 * https guard, and the CTA target policy so a regression in the kind-aware
 * routing/badging FAILS here.
 */

const roll = (
  recommendedCount: number,
  notRecommendedCount: number,
  recommendPct: number | null
): ListingRecommendRollup => ({ recommendedCount, notRecommendedCount, recommendPct });

function onsiteCard(
  over: Partial<ListingCard> & { hasPage: boolean; appBlockId?: string | null }
): ListingCard {
  const { hasPage, appBlockId = 'blk-1', ...rest } = over;
  return {
    id: 'l1',
    slug: 'my-app',
    kind: 'onsite',
    name: 'My App',
    tagline: null,
    category: null,
    contentRating: null,
    iconUrl: null,
    coverUrl: null,
    creator: null,
    recommend: roll(0, 0, null),
    reviewCount: 0,
    kindData: { kind: 'onsite', appBlockId, hasPage },
    ...rest,
  };
}

/**
 * 🔴 The `subKind` parameter is GONE. Off-site listings used to fork for display
 * into `connect` / `external-link`, derived from `connectClientId`; the card DTO
 * no longer carries either the sub-kind or the client id, so a card cannot
 * express the distinction at all. `externalUrl` is the only off-site input left.
 */
function offsiteCard(externalUrl: string | null): ListingCard {
  return {
    id: 'l2',
    slug: 'ext-app',
    kind: 'offsite',
    name: 'Ext App',
    tagline: null,
    category: null,
    contentRating: null,
    iconUrl: null,
    coverUrl: null,
    creator: null,
    recommend: roll(0, 0, null),
    reviewCount: 0,
    kindData: { kind: 'offsite', externalUrl },
  };
}

describe('getListingBadge', () => {
  // 🔴 PINNED LITERALLY, not derived from the constant it renders — writing
  // `toBe(EMBEDDED_KIND_LABEL)` would pass for every possible value of that constant.
  // The word a human reads, typed out. (Was `'App'` before the kind rename: not a
  // retired wording, just a word that was not the kind's name at all.)
  it('on-site → "Embedded"', () => {
    expect(getListingBadge(onsiteCard({ hasPage: true }))).toEqual({
      label: 'Embedded',
      kind: 'onsite',
    });
  });
  /**
   * 🔴 NEW BEHAVIOUR (not regression coverage): off-site used to badge as
   * "Connect app" when a client was linked and "Off-site" when not. There is one
   * badge now, and PR #4187 renamed its word to "Standalone". This pins the
   * collapsed pair — the "Connect app" case above is what a revert would put
   * back, and it is what this assertion refuses.
   */
  it('🔴 off-site → "Standalone", with or without a usable destination', () => {
    for (const externalUrl of [null, 'https://x.com', 'http://insecure.example']) {
      expect(getListingBadge(offsiteCard(externalUrl)), String(externalUrl)).toEqual({
        label: 'Standalone',
        kind: 'offsite',
      });
    }
  });
  /**
   * The word is load-bearing: it must be the SAME word the store's kind filter
   * puts on the whole category (`KindFilterButtons`' "Standalone"). Under the fork
   * the parent label was true of only one child while the submit flow minted
   * nothing but the other one. Pinned as a literal so a reword has to be
   * deliberate — PR #4187 renamed it Off-site → Standalone, and this assertion
   * moved with it.
   */
  it('🔴 the off-site badge label is exactly the store kind-filter word', () => {
    expect(getListingBadge(offsiteCard('https://x.com')).label).toBe('Standalone');
  });
});

describe('getRecommendLabel', () => {
  it('null pct → "No reviews yet"', () => {
    expect(getRecommendLabel(roll(0, 0, null), 0)).toBe('No reviews yet');
  });
  it('pct present → "N% recommend (M)" with rounding + count', () => {
    expect(getRecommendLabel(roll(9, 1, 0.9), 10)).toBe('90% recommend (10)');
    expect(getRecommendLabel(roll(2, 1, 0.6666), 3)).toBe('67% recommend (3)');
    expect(getRecommendLabel(roll(1, 0, 1), 1)).toBe('100% recommend (1)');
  });
  it('formats large counts with locale separators', () => {
    expect(getRecommendLabel(roll(1200, 300, 0.8), 1500)).toBe('80% recommend (1,500)');
  });
});

describe('safeExternalHref', () => {
  it('passes https', () => {
    expect(safeExternalHref('https://example.com')).toBe('https://example.com');
  });
  it('rejects http / non-https / dangerous / empty', () => {
    expect(safeExternalHref('http://example.com')).toBeNull();
    expect(safeExternalHref('javascript:alert(1)')).toBeNull();
    expect(safeExternalHref('ftp://x')).toBeNull();
    expect(safeExternalHref('')).toBeNull();
    expect(safeExternalHref(null)).toBeNull();
    expect(safeExternalHref(undefined)).toBeNull();
  });
});

describe('getListingDetailHref', () => {
  it('routes to the unified store-preview detail by slug', () => {
    expect(getListingDetailHref('my-app')).toBe('/apps/store-preview/my-app');
  });
  it('encodes an odd slug (defense in depth)', () => {
    expect(getListingDetailHref('a b/c')).toBe('/apps/store-preview/a%20b%2Fc');
  });
});

describe('getListingCta — on-site (P2c: View details → unified detail)', () => {
  it('hasPage + canOpenPage → Open → /apps/run/<slug> (direct primary)', () => {
    expect(
      getListingCta(onsiteCard({ hasPage: true, slug: 'gen-matrix' }), { canOpenPage: true })
    ).toEqual({
      label: 'Open',
      action: 'open',
      href: '/apps/run/gen-matrix',
      external: false,
    });
  });
  it('hasPage but NOT canOpenPage → View details → unified detail (no dead run link)', () => {
    expect(
      getListingCta(onsiteCard({ hasPage: true, slug: 'my-app' }), { canOpenPage: false })
    ).toEqual({
      label: 'View details',
      action: 'detail',
      href: '/apps/store-preview/my-app',
      external: false,
    });
  });
  it('!hasPage → View details → unified detail', () => {
    expect(
      getListingCta(onsiteCard({ hasPage: false, slug: 'my-app' }), { canOpenPage: true })
    ).toEqual({
      label: 'View details',
      action: 'detail',
      href: '/apps/store-preview/my-app',
      external: false,
    });
  });
  it('!hasPage + no appBlockId → still reaches the unified detail (never actionless)', () => {
    expect(
      getListingCta(onsiteCard({ hasPage: false, appBlockId: null, slug: 'my-app' }), {
        canOpenPage: true,
      })
    ).toEqual({
      label: 'View details',
      action: 'detail',
      href: '/apps/store-preview/my-app',
      external: false,
    });
  });
  it('encodes an odd slug on the Open run link', () => {
    expect(
      getListingCta(onsiteCard({ hasPage: true, slug: 'a b/c' }), { canOpenPage: true }).href
    ).toBe('/apps/run/a%20b%2Fc');
  });
});

describe('getListingCta — off-site (P2c: View details → unified detail)', () => {
  it('https externalUrl → Visit ↗ (direct external primary)', () => {
    expect(getListingCta(offsiteCard('https://foo.app'), { canOpenPage: true })).toEqual({
      label: 'Visit',
      action: 'visit',
      href: 'https://foo.app',
      external: true,
    });
  });
  it('non-https → View details → unified detail (guard drops the href)', () => {
    expect(getListingCta(offsiteCard('http://foo.app'), { canOpenPage: true })).toEqual({
      label: 'View details',
      action: 'detail',
      href: '/apps/store-preview/ext-app',
      external: false,
    });
  });
  it('null url → View details → unified detail', () => {
    expect(getListingCta(offsiteCard(null), { canOpenPage: true })).toEqual({
      label: 'View details',
      action: 'detail',
      href: '/apps/store-preview/ext-app',
      external: false,
    });
  });
  it('no usable target → View details → unified detail (fails safe)', () => {
    for (const externalUrl of [null, '', 'http://insecure.app', 'javascript:alert(1)']) {
      expect(
        getListingCta(offsiteCard(externalUrl), { canOpenPage: true }),
        String(externalUrl)
      ).toEqual({
        label: 'View details',
        action: 'detail',
        href: '/apps/store-preview/ext-app',
        external: false,
      });
    }
  });
});

describe('getOwnerEditHref (owner Edit deep-link)', () => {
  it('on-site → the UNIFIED /edit editor keyed on appBlockId (Item 2)', () => {
    expect(getOwnerEditHref({ kind: 'onsite', appBlockId: 'blk-1' }, 'l1')).toBe(
      '/apps/blk-1/edit'
    );
  });
  it('on-site with no backing appBlockId → null (no editable target → hide)', () => {
    expect(getOwnerEditHref({ kind: 'onsite', appBlockId: null }, 'l1')).toBeNull();
  });
  it('off-site → the submit editor keyed on the listing id (UNCHANGED)', () => {
    expect(getOwnerEditHref({ kind: 'offsite' }, 'l2')).toBe('/apps/submit?edit=l2');
  });
  it('accepts the full card kindData (extra fields are ignored)', () => {
    expect(
      getOwnerEditHref(onsiteCard({ hasPage: true, appBlockId: 'blk-9' }).kindData, 'l1')
    ).toBe('/apps/blk-9/edit');
    expect(getOwnerEditHref(offsiteCard('connect', null).kindData, 'l2')).toBe(
      '/apps/submit?edit=l2'
    );
  });
  it('encodes odd ids (defense in depth)', () => {
    expect(getOwnerEditHref({ kind: 'onsite', appBlockId: 'a b/c' }, 'l1')).toBe(
      '/apps/a%20b%2Fc/edit'
    );
    expect(getOwnerEditHref({ kind: 'offsite' }, 'a b/c')).toBe('/apps/submit?edit=a%20b%2Fc');
  });
});

describe('isEditableListingStatus / canOwnerEditListing (owner Edit gating)', () => {
  it('no status (approved-only store DTO) → editable', () => {
    expect(isEditableListingStatus(null)).toBe(true);
    expect(isEditableListingStatus(undefined)).toBe(true);
  });
  it('editable lifecycle statuses → editable', () => {
    expect(isEditableListingStatus('draft')).toBe(true);
    expect(isEditableListingStatus('pending')).toBe(true);
    expect(isEditableListingStatus('approved')).toBe(true);
  });
  it('mod-removed / rejected → NOT editable', () => {
    expect(isEditableListingStatus('removed')).toBe(false);
    expect(isEditableListingStatus('rejected')).toBe(false);
  });

  it('owner + editable → show', () => {
    expect(canOwnerEditListing({ isOwner: true })).toBe(true);
    expect(canOwnerEditListing({ isOwner: true, status: 'approved' })).toBe(true);
    expect(canOwnerEditListing({ isOwner: true, status: 'pending' })).toBe(true);
  });
  it('non-owner → hide (even for an editable status)', () => {
    expect(canOwnerEditListing({ isOwner: false })).toBe(false);
    expect(canOwnerEditListing({ isOwner: false, status: 'approved' })).toBe(false);
  });
  it('owner but mod-removed / rejected → hide', () => {
    expect(canOwnerEditListing({ isOwner: true, status: 'removed' })).toBe(false);
    expect(canOwnerEditListing({ isOwner: true, status: 'rejected' })).toBe(false);
  });
});

/**
 * ── ACTION-ROW GEOMETRY ─────────────────────────────────────────────────────
 *
 * 🔴 WHY THIS IS IN THE BLOCKING TIER AT ALL. The two numbers behind the action
 * row used to be magic values inside `AppListingCard.tsx`: one derived in a
 * comment, one read off a table, neither checkable. The component suite that
 * MEASURES them is the browser project, which is report-only in CI — so in CI
 * nothing at all held them. What CAN be gated here is the arithmetic and the
 * spelling, and both are where the drift actually happens.
 *
 * 🔴 WHAT THIS CANNOT SEE, stated rather than implied: it does not measure
 * anything. `LISTING_ACTIONS_WIDEST_PX` is a MEASUREMENT, and if the action
 * cluster's real width changes (a different trigger size, a longer CTA label)
 * this file stays green while the threshold silently stops matching reality.
 * That claim is made by `AppListingCard.browser.test.tsx`'s "AT the threshold"
 * test, which asserts all three terms against a real render.
 */
describe('the recommend-rollup floor and the container-query threshold', () => {
  const CARD_MODULE = path.resolve(__dirname, '../AppListingCard.tsx');
  const cardSource = () => fs.readFileSync(CARD_MODULE, 'utf8');
  /**
   * 🔴 EVERY ASSERTION BELOW IS A CLAIM ABOUT CODE, AND PROSE IS NOT CODE. This
   * file's comments deliberately quote the constants they explain — the note
   * recording that `@[360px]` was deleted contains the literal `@[360px]` — so a
   * raw `not.toContain` reads a correct file as an offence. Measured: that exact
   * false positive is why this stripper exists.
   */
  const cardCode = () =>
    cardSource()
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

  /** The single JSX opening tag that carries `substr`, as source text. */
  function enclosingTag(code: string, substr: string): string {
    const at = code.indexOf(substr);
    expect(at, `"${substr}" not found in AppListingCard.tsx`).toBeGreaterThan(-1);
    const open = code.lastIndexOf('<', at);
    const close = code.indexOf('>', at);
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    return code.slice(open, close + 1);
  }

  it('the threshold is the floor plus the gap plus the action cluster, rounded up to even', () => {
    expect(LISTING_ROLLUP_HIDE_BELOW_PX).toBe(
      LISTING_ACTIONS_WIDEST_PX + LISTING_ACTION_ROW_GAP_PX + LISTING_ROLLUP_MIN_WIDTH_PX
    );
    expect(LISTING_ROLLUP_HIDE_BELOW_PX).toBe(264);
  });

  it('rounding is UP and to an even number — never down', () => {
    // Rounding down would place the threshold BELOW the width at which the floor
    // first fits, i.e. it would render a row that overflows. Two odd sums and an
    // already-even one, so the branch is exercised rather than asserted about.
    expect(listingRollupHideThreshold(183, 10, 70)).toBe(264);
    expect(listingRollupHideThreshold(184, 11, 70)).toBe(266);
    expect(listingRollupHideThreshold(184, 10, 70)).toBe(264);
    for (const [a, g, f] of [
      [183, 10, 70],
      [184, 11, 70],
      [100, 7, 33],
    ] as const) {
      expect(listingRollupHideThreshold(a, g, f)).toBeGreaterThanOrEqual(a + g + f);
      expect(listingRollupHideThreshold(a, g, f) % 2).toBe(0);
    }
  });

  /**
   * 🔴 THE SPELLING GUARD. A Tailwind arbitrary variant cannot read a JS constant,
   * so `@[264px]` in the component and `LISTING_ROLLUP_HIDE_BELOW_PX` here are an
   * unavoidable duplication. What is avoidable is one moving without the other,
   * which is exactly the drift this asserts.
   */
  it("the component's container query spells the derived threshold", () => {
    const code = cardSource();
    const queries = [...code.matchAll(/@\[(\d+)px\]:/g)].map((m) => Number(m[1]));
    // Positive control: the pattern really does match something, so an equal-to
    // result is a match and not an empty sweep.
    expect(queries.length).toBeGreaterThan(0);
    expect([...new Set(queries)]).toEqual([LISTING_ROLLUP_HIDE_BELOW_PX]);
  });

  /**
   * 🔴 THE `@[360px]` BREAKPOINT IS GONE AND MUST STAY GONE. It existed only to
   * choose between a text Edit button and an icon-only one; both are now a single
   * `Menu.Item` behind a fixed-width `⋮` trigger, so it had nothing left to decide.
   * The assertion above already forbids it by enumerating the whole set — this one
   * names it, so a reader of a future failure knows which constant died and why.
   */
  it('the retired dual-Edit breakpoint is not reintroduced', () => {
    // Positive control on the stripper: the comment that NAMES the retired
    // breakpoint is still in the file, so a green result here is about code and not
    // about an empty read.
    expect(cardSource()).toContain('@[360px]');
    expect(cardCode()).not.toContain('@[360px]');
    // …and the stripper did not simply eat the file.
    expect(cardCode()).toContain('@[264px]:flex');
  });

  /**
   * 🔴 THE FLOOR IS ENFORCED, NOT MERELY DOCUMENTED. The rollup used to carry
   * `minWidth: 0`; the whole point of this change is that the number is now a
   * layout constraint. A revert to 0 is the mutation that makes the growing CTA
   * starve the rollup at every width, and it would leave every arithmetic
   * assertion above perfectly green.
   */
  it('the component applies the floor as the rollup min-width', () => {
    // 🔴 SCOPED TO THE ROLLUP'S OWN TAG, not to the file. Four other elements on
    // this card legitimately carry `minWidth: 0` (the creator chip, the title
    // stack, the action cluster) — a file-wide `not.toContain` fails against
    // correct code, which it did on the first run of this assertion.
    const tag = enclosingTag(cardCode(), "'hidden @[264px]:flex'");
    expect(tag).toContain('minWidth: LISTING_ROLLUP_MIN_WIDTH_PX');
    expect(tag).not.toMatch(/minWidth:\s*0\b/);
    // The tag really is the rollup's Group, not some enclosing element the index
    // walk happened to land on.
    expect(tag.startsWith('<Group')).toBe(true);
  });
});
