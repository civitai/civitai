import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import * as cardView from '~/components/Apps/appListingCardView';
import {
  canOwnerEditListing,
  getListingBadge,
  getListingCta,
  getListingDetailHref,
  getOwnerEditHref,
  getRecommendLabel,
  isEditableListingStatus,
  safeExternalHref,
} from '~/components/Apps/appListingCardView';
import {
  LISTING_ACTION_ROW_CONTROL_PX,
  LISTING_ACTION_ROW_GAP_PX,
  LISTING_ACTION_ROW_HEIGHT_PX,
  LISTING_ACTION_ROW_PT_PX,
  LISTING_CARD_COVER_ASPECT_RATIO,
  LISTING_CARD_ICON_SIZE_PX,
  LISTING_CARD_TITLE_LINES,
  LISTING_CARD_TITLE_LINE_HEIGHT,
  LISTING_CARD_TITLE_MIN_HEIGHT,
} from '~/components/Apps/appListingCardGeometry';
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
 * ── CARD GEOMETRY: ONE MODULE, READ NOT COPIED ──────────────────────────────
 *
 * 🔴 WHAT THIS TIER CAN AND CANNOT CLAIM. It cannot measure anything — that a
 * 36px control plus 10px of padding really renders a 46px row is a claim about a
 * browser and a stylesheet, and it lives in `AppListingCard.browser.test.tsx`
 * (which is REPORT-ONLY in CI). What it CAN gate, and what actually drifts, is
 * (a) the arithmetic between the constants and (b) whether the component still
 * READS them instead of re-spelling the numbers. Both are checked below.
 *
 * 🔴 THE RELATIONSHIP BEING PROTECTED IS CARD ⇄ SKELETON. `AppListingCardSkeleton`
 * (a later PR) must reserve exactly the geometry the real card occupies or the
 * grid reflows when the query resolves. A skeleton importing this module is
 * enough — provided the CARD imports it too. The moment a literal creeps back
 * into the component, the skeleton is pinned to a number the card no longer uses
 * and nothing here or there goes red. That is what the source assertions are for.
 */
describe('the card geometry module', () => {
  const CARD_MODULE = path.resolve(__dirname, '../AppListingCard.tsx');
  const cardSource = () => fs.readFileSync(CARD_MODULE, 'utf8');
  /**
   * 🔴 EVERY ASSERTION BELOW IS A CLAIM ABOUT CODE, AND PROSE IS NOT CODE. This
   * component's comments deliberately quote the constructs they explain — the
   * note recording that `@[264px]` was deleted contains the literal `@[264px]` —
   * so a raw `not.toContain` reads a correct file as an offence. Measured: that
   * exact false positive is why this stripper exists (it long predates this
   * change, and every retirement below re-earns it).
   */
  const cardCode = () =>
    cardSource()
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

  /**
   * 🔴 THE HUMAN-FACING NUMBERS, PINNED AS LITERALS — deliberately NOT derived
   * from the constants they describe.
   *
   * A test that reads the value out of the module and asserts it equals itself
   * cannot fail, and this file has a standing rule against exactly that (see the
   * badge-label note above). These are the figures a designer, a skeleton and the
   * browser suite all quote, so a change to any of them has to be typed twice —
   * which is the whole friction budget this test is spending.
   */
  it('pins the geometry a skeleton has to reproduce', () => {
    expect(LISTING_CARD_COVER_ASPECT_RATIO).toBe('16 / 9');
    expect(LISTING_CARD_ICON_SIZE_PX).toBe(40);
    expect(LISTING_CARD_TITLE_LINES).toBe(2);
    expect(LISTING_CARD_TITLE_LINE_HEIGHT).toBe(1.2);
    expect(LISTING_ACTION_ROW_PT_PX).toBe(10);
    expect(LISTING_ACTION_ROW_GAP_PX).toBe(10);
    expect(LISTING_ACTION_ROW_CONTROL_PX).toBe(36);
    expect(LISTING_ACTION_ROW_HEIGHT_PX).toBe(46);
  });

  /**
   * The one derivation in the module: the row height is its padding plus its
   * control, never a third number someone measured once. Asserted as arithmetic
   * AND against the literal above, so neither a wrong sum nor a right sum of
   * wrong terms survives.
   */
  it('derives the action-row height from its padding and its control', () => {
    expect(LISTING_ACTION_ROW_HEIGHT_PX).toBe(
      LISTING_ACTION_ROW_PT_PX + LISTING_ACTION_ROW_CONTROL_PX
    );
  });

  /**
   * 🔴 PARSED, NOT RE-CONSTRUCTED. Writing
   * ``expect(MIN_HEIGHT).toBe(`calc(${LINES} * ${LH}em)`)`` restates the
   * implementation and passes for every possible value of both terms. Pulling the
   * two numbers back OUT of the rendered string is an independent read: it fails
   * if the template ever stops carrying the constants, or carries them in the
   * wrong slots.
   */
  it('the reserved title height carries BOTH constants, in em', () => {
    const m = /^calc\((\d+(?:\.\d+)?) \* (\d+(?:\.\d+)?)em\)$/.exec(LISTING_CARD_TITLE_MIN_HEIGHT);
    expect(m, `unparseable min-height: ${LISTING_CARD_TITLE_MIN_HEIGHT}`).not.toBeNull();
    expect(Number(m![1])).toBe(LISTING_CARD_TITLE_LINES);
    expect(Number(m![2])).toBe(LISTING_CARD_TITLE_LINE_HEIGHT);
    // `em`, not `px`: it must resolve against the title's OWN font-size, so the
    // reservation stays correct if the title's `size` ever moves.
    expect(LISTING_CARD_TITLE_MIN_HEIGHT.endsWith('em)')).toBe(true);
  });

  /**
   * 🔴 THE COMPONENT READS THE MODULE — the assertion the card⇄skeleton
   * relationship actually rests on, and the one a values-only test cannot make.
   *
   * Named constants, one per geometry fact, so a failure says WHICH one stopped
   * being read rather than "the import list changed".
   */
  it('AppListingCard reads every geometry constant from the shared module', () => {
    const code = cardCode();
    // Positive control on the stripper: it did not simply eat the file.
    expect(code).toContain('export function AppListingCard');
    expect(code).toContain("from '~/components/Apps/appListingCardGeometry'");
    for (const name of [
      'LISTING_CARD_COVER_ASPECT_RATIO',
      'LISTING_CARD_ICON_SIZE_PX',
      'LISTING_CARD_TITLE_LINES',
      'LISTING_CARD_TITLE_LINE_HEIGHT',
      'LISTING_CARD_TITLE_MIN_HEIGHT',
      'LISTING_ACTION_ROW_PT_PX',
      'LISTING_ACTION_ROW_GAP_PX',
      'LISTING_ACTION_ROW_CONTROL_PX',
    ]) {
      // Twice: once in the import list, once at the use site. A constant that is
      // imported and never read is exactly the state a re-literalised value
      // leaves behind, and it is invisible to a bare `toContain`.
      const uses = [...code.matchAll(new RegExp(name, 'g'))].length;
      expect(
        uses,
        `${name} is imported but never read in AppListingCard.tsx`
      ).toBeGreaterThanOrEqual(2);
    }
  });

  /**
   * 🔴 THE MIRROR IMAGE, AND THE HALF THAT ACTUALLY CATCHES A REGRESSION. "It
   * imports the module" stays true when someone adds a literal BESIDE the
   * constant — which is how a card and a skeleton drift while every import
   * assertion is green. These are the exact literals the constants replaced.
   */
  it('AppListingCard spells none of those numbers itself', () => {
    const code = cardCode();
    for (const [literal, why] of [
      ["aspectRatio: '16 / 9'", 'cover ratio'],
      ['size={40}', 'app-icon avatar'],
      ['triggerSize={36}', 'menu trigger / row-height contract'],
      ['pt="xs"', 'action-row padding'],
      ['line-clamp-2', 'reserved title lines'],
      ['lh={1.2}', 'title line-height'],
    ] as const) {
      expect(code, `${why}: re-literalised as \`${literal}\``).not.toContain(literal);
    }
    // Positive control: the stripper leaves OTHER literals alone, so the six
    // absences above are about these constructs and not about an empty read.
    expect(code).toContain('line-clamp-3'); // the tagline's clamp, deliberately not geometry
  });
});

/**
 * ── THE RETIRED ACTION-ROW GEOMETRY ─────────────────────────────────────────
 *
 * 🔴 WHAT USED TO BE HERE, AND WHY ITS GUARD IS GONE RATHER THAN RELAXED.
 *
 * `appListingCardView` exported `LISTING_ROLLUP_MIN_WIDTH_PX` (70),
 * `LISTING_ACTIONS_WIDEST_PX` (184), `listingRollupHideThreshold()` and
 * `LISTING_ROLLUP_HIDE_BELOW_PX` (264 = 184 + 10 + 70), and this file asserted
 * that `AppListingCard.tsx`'s `@[264px]:flex` Tailwind class spelled the same
 * number — a Tailwind arbitrary variant cannot read a JS constant, so the
 * duplication was unavoidable and the DRIFT was what got gated.
 *
 * All of it existed for ONE reason: the recommend rollup shared the action row
 * with the CTA, so it needed an enforced floor, a breakpoint below which it was
 * hidden rather than crushed, and a derived threshold to place that breakpoint.
 * The rollup now lives in the card's meta block. There is no shared row, no
 * floor, no container query and no threshold — so the drift guard is not
 * weakened, it has no subject.
 *
 * 🔴 LEAVING IT ASSERTING THE OLD COUPLING WOULD HAVE BEEN THE WORST OUTCOME: a
 * green test claiming a relationship that no longer exists reads as coverage and
 * stops anyone looking. Deleting it silently is the second worst. So the deletion
 * is asserted instead — the exports must be GONE, not merely unused, because a
 * surviving constant with no consumer is the shape that gets wired back in later.
 */
describe('the retired rollup-floor constants', () => {
  it('are no longer exported by the card view-model', () => {
    // Runtime keys, not a source grep: the module's tombstone comment names all
    // four, so a text search would report them present in a correct file.
    const exported = Object.keys(cardView);
    // Positive control — the module still exports the things it is FOR, so an
    // empty `exported` cannot satisfy the absences below.
    expect(exported).toContain('getRecommendLabel');
    expect(exported).toContain('getListingCta');
    for (const gone of [
      'LISTING_ROLLUP_MIN_WIDTH_PX',
      'LISTING_ROLLUP_HIDE_BELOW_PX',
      'LISTING_ACTIONS_WIDEST_PX',
      'LISTING_ACTION_ROW_GAP_PX',
      'listingRollupHideThreshold',
    ]) {
      expect(exported, `${gone} came back to appListingCardView`).not.toContain(gone);
    }
  });

  it('and the container query they placed is gone from the component', () => {
    const CARD_MODULE = path.resolve(__dirname, '../AppListingCard.tsx');
    const source = fs.readFileSync(CARD_MODULE, 'utf8');
    const code = source
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    // Positive control on the stripper: the comments that NAME the retired
    // breakpoints are still in the file, so a green result here is about code.
    expect(source).toContain('@[264px]');
    expect(source).toContain('@[360px]');
    // 🔴 NO arbitrary container variant survives — enumerated rather than named,
    // so a NEW one cannot slip in under a check that only forbids the old two.
    expect([...code.matchAll(/@\[(\d+)px\]:/g)].map((m) => m[1])).toEqual([]);
    // …and the card no longer declares itself a query container at all, because
    // nothing on it is size-queried any more.
    expect(code).not.toContain('@container');
    // Positive control: the OTHER classes on that same element are untouched, so
    // the two absences are about the container query and not about a card whose
    // className was emptied.
    expect(code).toContain('rounded-md');
    expect(code).toContain('h-full');
  });
});
