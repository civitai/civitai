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
  getPlayCountLabel,
  getRecommendLabel,
  isEditableListingStatus,
  safeExternalHref,
} from '~/components/Apps/appListingCardView';
import * as geometry from '~/components/Apps/appListingCardGeometry';
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

/**
 * 🔴 THE PLAY COUNT'S NULL-VS-ZERO RULE — AND THIS IS THE TIER THAT OWNS IT.
 *
 * The rule is an OPERATOR OVERRIDE (2026-09-06), not a formatting derivation:
 * `openCount === null` means the number is STRUCTURALLY UNMEASURABLE (an off-site
 * listing's CTA is a third-party `target="_blank"` anchor, so nothing on-platform
 * observes the click), and such a card renders NO play stat at all — a `0` there
 * would read as "nobody has ever used this app" about an app we cannot measure.
 * The mirror is equally deliberate: an ON-SITE listing with a genuine `0` renders
 * "0 plays", because there the zero IS the measurement.
 *
 * 🔴 IT IS TESTED HERE RATHER THAN ONLY IN THE BROWSER TIER BECAUSE OF WHICH TIER
 * GOES RED. `AppListingCard.browser.test.tsx` renders the real card and asserts the
 * omission end-to-end, but the browser `component` project never blocks anything;
 * the node `unit` project at least reddens a `main` push. Expressing the rule as a
 * pure function is what makes it visible to this tier at all — as JSX
 * (`card.openCount != null && …`) it would be invisible here. (Neither tier gates a
 * PR: `lint.yml` marks both `continue-on-error` for `pull_request`. Canonical
 * statement: `appListingCardGeometry.ts`'s header.)
 *
 * 🔴 THE FIXTURES ARE PAIRWISE DISTINCT AND SHARE NOTHING WITH THE STRINGS
 * ASSERTED. 4821 → "4.8k" and 1_234_567 → "1.2m" are values whose rendered form
 * contains none of their own digits in order, so a mutant that dropped
 * `abbreviateNumber` and printed the raw number cannot produce them; and the two
 * counts differ in magnitude BAND, so a mutant that hardcoded one suffix survives
 * neither.
 */
describe('getPlayCountLabel', () => {
  it('🔴 null → null, so the caller has no number to print', () => {
    expect(getPlayCountLabel(null)).toBeNull();
  });

  it('🔴 a genuine ZERO is a measurement, not an absence → "0 plays"', () => {
    // The mutation this refuses is `if (!openCount) return null`, which collapses
    // the unmeasurable case and the measured-as-none case into one.
    expect(getPlayCountLabel(0)).toBe('0 plays');
  });

  it('singular at exactly 1, plural either side of it', () => {
    expect(getPlayCountLabel(1)).toBe('1 play');
    expect(getPlayCountLabel(2)).toBe('2 plays');
    expect(getPlayCountLabel(0)).toBe('0 plays');
  });

  it('abbreviates a large count rather than printing separators', () => {
    expect(getPlayCountLabel(4821)).toBe('4.8k plays');
    expect(getPlayCountLabel(1_234_567)).toBe('1.2m plays');
  });

  /**
   * 🔴 THE PLURAL READS THE RAW VALUE, NOT THE ABBREVIATED STRING. 1000
   * abbreviates to "1k", so a pluraliser written against the rendered text
   * (`label.startsWith('1') ? 'play' : 'plays'`, or anything derived from the
   * abbreviation) says "1k play". The distinction is unobservable at every count
   * below 1000, which is why it needs its own fixture.
   */
  it('🔴 1000 is "1k plays" — the plural is not derived from the abbreviation', () => {
    expect(getPlayCountLabel(1000)).toBe('1k plays');
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
 * browser and a stylesheet, and it lives in `AppListingCard.browser.test.tsx`,
 * which never blocks anything. What this file CAN catch — on the next `main` push,
 * NOT on the PR; see the canonical tier note in `appListingCardGeometry.ts` — is
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
   * 🔴 THE LIST IS THE MODULE'S OWN EXPORTS, NOT A LIST SOMEONE MAINTAINS. It used
   * to be nine names typed out here, and it contained eight — the title said "every
   * geometry constant" while `LISTING_ACTION_ROW_HEIGHT_PX` was silently omitted,
   * and that constant had NO production consumer at all. The description was wider
   * than the body, which is the shape that reads as coverage while providing none.
   * Deriving the list from `Object.keys` makes the omission impossible to repeat AND
   * makes the guard cover constants nobody has written yet: add one to the module
   * without reading it in the card and this fails, NAMING it.
   *
   * 🔴 "NAMING IT" IS TRUE ONLY BECAUSE THE COUNT CHECK RUNS LAST, and it did not
   * at first. `expect(exported).toHaveLength(9)` sat ABOVE the loop, so the first
   * failure a reader saw was `expected [ …(10) ] to have a length of 9 but got 10`
   * — the guard fired, but the constant was not named until someone bumped 9 to 10
   * and re-ran. That is the description-wider-than-its-body class this very file
   * exists to close, reintroduced inside the commit that closed it. The loop now
   * runs FIRST, so an unread export is named on the first failure and the count is
   * the backstop for the case where someone adds an export AND reads it.
   */
  it('AppListingCard reads every geometry constant the module exports', () => {
    const code = cardCode();
    // Positive control on the stripper: it did not simply eat the file.
    expect(code).toContain('export function AppListingCard');
    expect(code).toContain("from '~/components/Apps/appListingCardGeometry'");

    const exported = Object.keys(geometry);
    // Positive control on the enumeration BEFORE the loop, so a module that
    // exported nothing cannot make the loop vacuously green. Deliberately a
    // non-zero LOWER BOUND rather than the exact count — the exact count is the
    // backstop below, and putting it here is what buried the named failure.
    expect(exported.length, 'appListingCardGeometry exports nothing').toBeGreaterThan(0);
    expect(exported).toContain('LISTING_ACTION_ROW_HEIGHT_PX');

    for (const name of exported) {
      // Twice: once in the import list, once at the use site. A constant that is
      // imported and never read is exactly the state a re-literalised value
      // leaves behind, and it is invisible to a bare `toContain`.
      const uses = [...code.matchAll(new RegExp(name, 'g'))].length;
      expect(
        uses,
        `${name} is exported by appListingCardGeometry but never read in AppListingCard.tsx ` +
          `(found ${uses} occurrence(s); an import with no use site counts as 1)`
      ).toBeGreaterThanOrEqual(2);
    }

    // 🔴 THE BACKSTOP, RUN LAST ON PURPOSE. It catches the one case the loop
    // cannot — an export ADDED and dutifully read, which should still be a
    // deliberate act — and it is here rather than above so that the common failure
    // (an export nobody reads) is reported by NAME first. 9 is typed out.
    expect(
      exported,
      'appListingCardGeometry gained or lost an export. If you added one, the loop ' +
        'above already proved the card reads it — bump this count deliberately, and ' +
        'make sure AppListingCardSkeleton reads it too.'
    ).toHaveLength(9);
  });

  /**
   * 🔴 THE ACTION ROW'S PROP LEDGER — the assertion that makes the NODE tier able
   * to see a row-height regression at all.
   *
   * ⚠️ "NODE", NOT "BLOCKING". An earlier draft of this docblock called it the
   * blocking tier and priced the guard as a merge gate. It is not one on a PR —
   * `lint.yml` makes both `unit` and `geometry` `continue-on-error` for
   * `pull_request` events. What this buys is catching the regression on the next
   * push to `main` instead of never. Canonical statement:
   * `appListingCardGeometry.ts`'s header.
   *
   * 🔴 THIS EXISTS BECAUSE THE OBVIOUS GUARD IS BLIND. Row height is 46px, derived
   * as `PT + CONTROL`, and MEASURED at three container widths — in the browser
   * project, which never blocks. So the only tier that ever blocks anything cannot
   * measure the row, and until this test existed a change that moved the row's
   * height reached `main` unremarked. The worked case, produced by an audit rather than
   * imagined: adding `pb={10}` beside the `pt` renders a 56px row while
   * `LISTING_ACTION_ROW_HEIGHT_PX` still says 46; every node assertion stayed green,
   * and PR3's skeleton would have imported 46, reserved 10px too little, and
   * reflowed the grid on every query resolve. Nothing would have stopped that PR
   * merging either way — what this adds is that `main` goes red immediately after,
   * rather than the defect living until someone measures a card by hand.
   *
   * 🔴 IT IS A LEDGER, NOT A CONTAINMENT CHECK, and that is the whole design. The
   * hazard is a prop being ADDED, so a test that merely requires `pt` and `mih` to
   * be present cannot see it. This asserts the EXACT SET, so it fails when the set
   * grows as well as when it shrinks — and it fails loudly enough to name the prop.
   *
   * 🔴 WHAT IT STILL CANNOT SEE, stated rather than implied, and the two halves are
   * NOT equally covered. It reads the row's own opening tag, so height moved by a
   * CHILD is invisible to it — and only ONE of the two children is picked up
   * elsewhere in this node tier:
   *
   *   - `triggerSize` IS covered: it reads `LISTING_ACTION_ROW_CONTROL_PX`, so the
   *     "reads every constant" test above and that constant's literal pin both see
   *     a change to it.
   *   - **the CTA is NOT.** Its 36px comes from Mantine's `size="sm"` token, which
   *     no constant in the geometry module touches. Measured: flipping the CTA to
   *     `size="md"` leaves this whole node file green at 45/45, and only the
   *     browser tier reds. An earlier draft of this note said a child change was
   *     "caught by the constants' own literal pins plus the browser measurements",
   *     which credits this file with coverage it does not have for half the row.
   *
   * `AppListingCard.browser.test.tsx` now asserts the CTA's RENDERED height as well
   * as the trigger's, which is the real guard on that term — but that tier never
   * blocks, so a CTA size bump is caught by NOTHING that can stop a merge and by
   * nothing that reddens `main` either. Do not read this ledger as covering it.
   * Closing it properly is a ~5-line change (promote the size token into
   * `appListingCardGeometry.ts` so the `Object.keys` loop above covers it
   * automatically); it is deliberately deferred to a follow-up rather than done
   * here, because it is production payload.
   */
  it("🔴 the action row's prop set is exactly the geometry it declares", () => {
    const code = cardCode();
    // Locate the row by `mt="auto"` — the only bottom-pinned element on the card,
    // and the same discriminator the browser suite's `actionRow()` uses after
    // `--group-wrap` alone proved insufficient there.
    const at = code.indexOf('mt="auto"');
    expect(at, 'no bottom-pinned action row found in AppListingCard.tsx').toBeGreaterThan(-1);
    const open = code.lastIndexOf('<', at);
    const close = code.indexOf('>', at);
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(at);
    const tag = code.slice(open, close + 1);
    // It really is the row's Group, not some enclosing element the index walk
    // happened to land on.
    expect(tag.startsWith('<Group')).toBe(true);

    // 🔴 NO SPREAD, ASSERTED FIRST AND SEPARATELY. A spread carries props the name
    // scan below CANNOT see — it has no `name=` to match — so `{...{ pb: 10 }}`,
    // or the realistic `{...(compact ? { pt: 4, pb: 0 } : {})}` for a dense
    // variant, changes the rendered row height while leaving the set unchanged.
    // Measured green at 45/45 against the version of this test before the spread
    // check existed. A ledger that can be walked past by writing the same prop a
    // different way is a SPELLED guard, and this one's own comment claimed it was not.
    //
    // 🔴 A REGEX, NOT `toContain('{...')` — AND THE FIRST VERSION *WAS* THAT
    // `toContain`, i.e. this guard shipped as an instance of the exact class it
    // exists to close. JSX permits whitespace inside a spread attribute, so
    // `{ ...{ pb: 10 } }` is valid, parses identically, and contains no literal
    // `{...`. Measured: the spaced form left this file 45/45 GREEN while the
    // browser tier reported 5 reds at `expected 56 to be 46` — the row really did
    // render 10px taller and the source-reading tier saw nothing. The argument six
    // lines below (prettier normalises the spacing, but nothing that gates a merge
    // runs prettier) applies here word for word and was simply not applied.
    //
    // 🔴 `\s\{` RATHER THAN `\{`, so an OBJECT spread in a prop VALUE is not
    // flagged: a JSX spread attribute is preceded by whitespace, while
    // `style={{ ...base, pt: 10 }}` has its brace preceded by `=`/`{`. That form is
    // a different hazard — it is a `style` prop, so the NAME ledger below catches
    // it — and flagging it here would be a false positive on correct code.
    expect(
      tag,
      `the action row's opening tag contains a JSX spread. A spread can carry padding or ` +
        `height props that the prop-name ledger below cannot see, so the row's 46px ` +
        `height would change with every node assertion green. Write the props literally.`
    ).not.toMatch(/\s\{\s*\.\.\./);

    // The prop NAMES, in source order. `pb`, `p`, `py`, `h`, `mah`, `style` — or
    // anything else that can move a flex row's height — makes this set grow.
    //
    // 🔴 SPLIT ON ANY WHITESPACE, NOT ON A LINE START. This was `/\n\s+([a-zA-Z-]+)=/`,
    // which required a prop to BEGIN A LINE — so `mt="auto" pb={10}` on one line
    // slipped a second prop past it, also measured green at 45/45. Prettier would
    // reformat that onto its own line and the ledger would then red, but nothing
    // that runs before a merge runs prettier over this file:
    // `.github/workflows/lint.yml`'s `Prettier (modified files, report-only)` job
    // is `continue-on-error: true` and only ADDED files are checked at all —
    // `AppListingCard.tsx` is a modified file. So the unformatted spelling can
    // reach `main`, and the guard has to read it as written.
    const props = [...tag.matchAll(/\s([a-zA-Z-]+)=/g)].map((m) => m[1]);
    expect(
      props,
      `the action row's props changed — every one of them can move the 46px row height, ` +
        `which the node tier cannot measure. Update this ledger deliberately, ` +
        `and re-measure the row in AppListingCard.browser.test.tsx.`
    ).toEqual(['mt', 'pt', 'mih', 'gap', 'wrap']);

    // …and each geometry prop reads its constant rather than a literal. `mih` is
    // the height constant's ONLY production consumer; without it the module's
    // "the card READS every value" claim, this file's "reads every geometry
    // constant" test title, and the loop above were all wider than the code.
    expect(tag).toContain('pt={LISTING_ACTION_ROW_PT_PX}');
    expect(tag).toContain('mih={LISTING_ACTION_ROW_HEIGHT_PX}');
    expect(tag).toContain('gap={LISTING_ACTION_ROW_GAP_PX}');
    // Positive control on the tag slice: `mt="auto"` is a literal on purpose (it is
    // not geometry, it is "bottom-pinned"), so a green result above is about the
    // three constants and not about a slice that matched nothing.
    expect(tag).toContain('mt="auto"');
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

  /**
   * 🔴 THE STATS LINE IS BELOW THE ACTION ROW, IN SOURCE ORDER — the node tier's
   * half of the operator's ask ("move reviews + plays below the CTA").
   *
   * ⚠️ STRUCTURAL, AND SAY SO. This reads the SOURCE, so it proves the elements are
   * written in that order, not that they RENDER in it — a `position: absolute` or an
   * `order:` property would defeat it, and neither is used here. The RENDERED claim
   * (the rollup's `top` is at or below the row's `bottom`, measured against the real
   * cascade) lives in `AppListingCard.browser.test.tsx`. This exists because that
   * tier never blocks anything, while this one at least reddens a `main` push, and
   * because "the rollup went back into the meta block" is precisely the regression a
   * source-order check CAN see.
   *
   * 🔴 THE ANCHOR IS `mt="auto"`, THE SAME DISCRIMINATOR the prop-ledger test above
   * and the browser suite's `actionRow()` use — the only bottom-pinned element on
   * the card. A positional index would have to be re-derived on every insertion.
   */
  it('🔴 the stats line (rollup + play count) is written BELOW the action row', () => {
    const code = cardCode();
    const row = code.indexOf('mt="auto"');
    const stats = code.indexOf('data-testid="apps-listing-card-stats"');
    const rollup = code.indexOf('data-testid="apps-listing-recommend-rollup"');
    const play = code.indexOf('data-testid="apps-listing-play-count"');

    // Positive controls FIRST — each element must actually be in the (stripped)
    // source, or every ordering comparison below is between −1 and a real index and
    // would read as a confident pass or a confusing fail.
    expect(row, 'no bottom-pinned action row in AppListingCard.tsx').toBeGreaterThan(-1);
    expect(stats, 'the card renders no stats line').toBeGreaterThan(-1);
    expect(rollup, 'the card renders no recommend rollup').toBeGreaterThan(-1);
    expect(play, 'the card renders no play count').toBeGreaterThan(-1);

    expect(
      stats,
      'the stats line is written ABOVE the action row. The operator asked for reviews + ' +
        'plays BELOW the CTA; above it is where the rollup used to live (in the meta block).'
    ).toBeGreaterThan(row);
    // …and both stats are INSIDE that line, not scattered.
    expect(rollup, 'the recommend rollup is outside the stats line').toBeGreaterThan(stats);
    expect(play, 'the play count is outside the stats line').toBeGreaterThan(stats);
    // Reviews before plays — the order the operator named.
    expect(rollup, 'the play count is written before the recommend rollup').toBeLessThan(play);

    // 🔴 THE STATS LINE MUST NOT WRAP. Two stats on one `nowrap` line is what keeps
    // an off-site card (which omits the play count) the same HEIGHT as an on-site
    // one, which is the whole licence for `AppListingCardSkeleton` reserving a
    // single line without knowing the listing's kind.
    //
    // 🔴 READ OFF THAT ELEMENT'S **OWN** OPENING TAG, delimited exactly the way the
    // prop-ledger test above delimits the action row's — and the first version of
    // this assertion was a 400-character WINDOW around the testid instead, which
    // is why the delimiting is spelled out here. Measured: flipping this Group to
    // `wrap="wrap"` left the window green, because the ROLLUP's own nested
    // `wrap="nowrap"` sits ~60 characters later and satisfied a `toContain`. A
    // guard that can be satisfied by a NEIGHBOUR's identical prop is reading the
    // wrong element, not making a weak claim.
    const open = code.lastIndexOf('<', stats);
    const close = code.indexOf('>', stats);
    expect(open, 'no opening tag found for the stats line').toBeGreaterThan(-1);
    expect(close, 'unterminated opening tag on the stats line').toBeGreaterThan(stats);
    const tag = code.slice(open, close + 1);
    // The slice really is the stats line's own tag, not an enclosing element the
    // index walk landed on — otherwise the assertion below is about something else.
    expect(tag.startsWith('<Group')).toBe(true);
    expect(tag).toContain('data-testid="apps-listing-card-stats"');
    expect(
      tag,
      'the stats line is not `wrap="nowrap"`. A wrapped stats line is a SECOND line, ' +
        'i.e. every card taller than its skeleton inside an h-full grid row.'
    ).toContain('wrap="nowrap"');
  });

  /**
   * 🔴 THE AUTHOR CHIP IS GONE FROM THE CARD'S CODE, not merely unrendered.
   *
   * The operator dropped the "by {creator}" line from the store card (2026-09-06).
   * A `CreatorChip` left in the file but uncalled is the shape that gets wired back
   * in by the next person who wants a byline, so the component was deleted; this
   * asserts that rather than trusting it.
   *
   * 🔴 READ OFF THE **STRIPPED** SOURCE, and the distinction is load-bearing here
   * more than anywhere else in this file: `AppListingCard.tsx` deliberately keeps a
   * docblock NAMING the retired `CreatorChip` and explaining where attribution went.
   * An unstripped scan would read that prose and report the component present.
   */
  it('🔴 the card declares no CreatorChip and links to no user profile', () => {
    const code = cardCode();
    const source = fs.readFileSync(path.resolve(__dirname, '../AppListingCard.tsx'), 'utf8');

    // Positive control on the stripper, in BOTH directions: the prose that names the
    // retired component is in the file and is NOT in the stripped code, so a green
    // result below is about code rather than about a scan that ate everything.
    expect(source, 'the tombstone explaining where the author chip went is gone').toContain(
      'CreatorChip'
    );
    expect(code).not.toContain('CreatorChip');
    expect(code, 'the stripper ate the component itself').toContain(
      'export function AppListingCard'
    );

    // The chip's two other fingerprints — the profile href it built, and the
    // CDN-avatar helper it was the only consumer of on this card.
    expect(code, 'the card still builds a /user/<name> profile link').not.toContain('/user/');
    expect(code, 'getEdgeUrl is still imported — it had no other consumer here').not.toContain(
      'getEdgeUrl'
    );
    // `card.creator` itself is STILL read — for the owner test and the menu target —
    // so this is a rendering change, not a DTO one. Asserted so the absences above
    // cannot be satisfied by dropping the field entirely.
    expect(code, 'the card stopped reading card.creator at all — isOwner is now dead').toContain(
      'card.creator?.id'
    );
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
describe('the retired rollup-floor constants (four deleted, one moved)', () => {
  it('the four DELETED ones are gone from the card view-model', () => {
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
      'listingRollupHideThreshold',
    ]) {
      expect(exported, `${gone} came back to appListingCardView`).not.toContain(gone);
    }
  });

  /**
   * 🔴 THE FIFTH ONE MOVED, AND SAYING "DELETED" ABOUT IT WAS AN ERROR WITH A
   * FAILURE MODE. `LISTING_ACTION_ROW_GAP_PX` still exists, under the same name, in
   * `appListingCardGeometry`; the card reads it as the action row's `gap`. A
   * tombstone claiming all five were deleted sends the next person who needs a row
   * gap off to mint a SECOND copy — the two-copies drift this whole PR removes.
   *
   * So this asserts the MOVE as a relationship — absent from the old home AND
   * present in the new one — rather than just the absence. An absence alone is
   * equally true of a genuinely deleted constant, which is the reading that was
   * wrong.
   */
  it('the fifth MOVED to the geometry module, and is live in both senses', () => {
    expect(Object.keys(cardView)).not.toContain('LISTING_ACTION_ROW_GAP_PX');
    expect(
      Object.keys(geometry),
      'LISTING_ACTION_ROW_GAP_PX moved to appListingCardGeometry — if it is gone from ' +
        'there too then it was deleted after all, and the tombstone in ' +
        'appListingCardView.ts is now wrong in the other direction'
    ).toContain('LISTING_ACTION_ROW_GAP_PX');
    // Same value it had at the old home — a move, not a redefinition.
    expect(geometry.LISTING_ACTION_ROW_GAP_PX).toBe(10);
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
