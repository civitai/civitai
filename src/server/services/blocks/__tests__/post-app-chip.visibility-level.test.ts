import { describe, expect, it } from 'vitest';

import {
  listingIdsInChipRow,
  projectPostAppChip,
} from '~/server/services/blocks/post-app-chip.logic';

/**
 * 🔴 THE THIRD PUBLIC SURFACE THAT LINKS A LISTING, AND THE ONE W14 FORGOT.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────────
 * `post-app-chip` gates on `app_listings.status = 'approved'` and never consulted the
 * per-listing VISIBILITY LEVEL. So an owner setting `private` (or `moderators`, or
 * `testers`) on an APPROVED listing made the store drop it from the grid and 404 its detail
 * page — while every public post made with that app went on showing its name, its icon and
 * a link, and the click 404'd.
 *
 * That is precisely the failure the module's own docblock says it exists to prevent: *"a
 * chip that links a row that read refuses is exactly the '404 dressed as a working link'
 * this feature was supposed to avoid"*. It enumerates THREE grounds `getListingDetail`
 * rejects on; W14 added a fourth and updated only two of the three surfaces.
 *
 * ── THE SHAPE OF THE FIX, AND WHY IT IS A LIFECYCLE TERM ────────────────────────
 * A hidden listing degrades to NAME-UNLINKED rather than vanishing, which is the same
 * treatment a `removed` listing already gets — the chip's lifecycle/maturity split puts
 * "does the store have a page for this?" on the lifecycle side. Vanishing would have been a
 * second, different behaviour for the same question.
 *
 * The level is resolved for the `public` floor ONLY: strictly narrower than any real
 * viewer's floor, so the chip can only ever UNDER-link. The module already accepts that
 * direction for its block-status term ("strictly narrower than the store's, so it can only
 * ever under-link").
 *
 * ⚠️ `[REG]` THROUGHOUT. Every case here is red on the pre-fix tree: `readListingCandidate`
 * took two arguments and had no level term, so a hidden listing produced a LINKED chip.
 */

/** A row shaped as `postAppChipQuery` returns it, approved and deployed on both sides. */
function chipRow(over: Record<string, unknown> = {}) {
  return {
    name: 'Client Name',
    appBlocks: [
      {
        status: 'approved',
        currentVersionDeployedAt: new Date('2026-01-01'),
        appListing: {
          id: 'apl_vis',
          slug: 'cool-app',
          name: 'Cool App',
          status: 'approved',
          kind: 'onsite',
          contentRating: null,
          revisionOfId: null,
          icon: null,
          ...over,
        },
      },
    ],
  } as never;
}

const HOST = 'civitai.com';
const NONE: ReadonlySet<string> = new Set<string>();

describe('the post chip honours the per-listing visibility level', () => {
  it('[REG][POSITIVE CONTROL] a visible approved listing is LINKED', () => {
    // Without this the nulls/unlinked assertions below are indistinguishable from a
    // fixture that never produced a chip at all.
    const chip = projectPostAppChip(chipRow(), { host: HOST, hiddenListingIds: NONE });
    expect(chip).not.toBeNull();
    expect(chip?.slug).toBe('cool-app');
    expect(chip?.name).toBe('Cool App');
  });

  it('🔴 [REG] a HIDDEN approved listing is NOT linked — no 404 dressed as a working link', () => {
    const chip = projectPostAppChip(chipRow(), {
      host: HOST,
      hiddenListingIds: new Set(['apl_vis']),
    });
    // The chip still names the app (same as a `removed` listing) but carries no link.
    expect(chip).not.toBeNull();
    expect(chip?.slug, 'a hidden listing must not be linked').toBeFalsy();
  });

  it('[REG] the set is matched by listing ID, not by slug or name', () => {
    // A set keyed on the wrong field would be a guard that never fires. Both of these must
    // leave the chip linked, because neither names the listing's id.
    for (const wrong of ['cool-app', 'Cool App']) {
      const chip = projectPostAppChip(chipRow(), {
        host: HOST,
        hiddenListingIds: new Set([wrong]),
      });
      expect(chip?.slug, `\`${wrong}\` must not be treated as a listing id`).toBe('cool-app');
    }
  });

  it('[INV] an ABSENT set degrades to pre-feature behaviour rather than throwing', () => {
    // 🔴 THIS RUNS ON A PUBLIC POST PAGE. The parameter is required by the type so review
    // cannot miss it, but a JS caller that omits it must not take the post down — a chip is
    // cosmetic. Same posture as the `…ForRender` readers elsewhere in this feature.
    const chip = projectPostAppChip(chipRow(), {
      host: HOST,
    } as never);
    expect(chip?.slug).toBe('cool-app');
  });

  it('[INV] a listing with no id is unaffected — the term cannot fire on it', () => {
    // Hand-built fixtures elsewhere in this suite carry no `id`; they must keep their
    // pre-W14 behaviour rather than silently becoming unlinked.
    const chip = projectPostAppChip(chipRow({ id: undefined }), {
      host: HOST,
      hiddenListingIds: new Set(['apl_vis']),
    });
    expect(chip?.slug).toBe('cool-app');
  });
});

describe('listingIdsInChipRow — the input to the batched level read', () => {
  it('[REG] collects the candidate listing ids', () => {
    expect(listingIdsInChipRow(chipRow())).toEqual(['apl_vis']);
  });

  it('[REG] returns an EMPTY array for a row with no listing, so no query is issued', () => {
    // The common path is an ordinary hand-made post. It must cost nothing extra — the
    // resolver skips the read entirely on an empty list.
    expect(listingIdsInChipRow(null)).toEqual([]);
    expect(listingIdsInChipRow({ name: 'x', appBlocks: [] } as never)).toEqual([]);
    expect(
      listingIdsInChipRow({ name: 'x', appBlocks: [{ status: 'approved' }] } as never)
    ).toEqual([]);
  });

  it('[REG] de-duplicates, so N blocks on one listing are ONE bound parameter', () => {
    const row = {
      name: 'x',
      appBlocks: [
        { appListing: { id: 'apl_a' } },
        { appListing: { id: 'apl_a' } },
        { appListing: { id: 'apl_b' } },
      ],
    } as never;
    expect(listingIdsInChipRow(row).sort()).toEqual(['apl_a', 'apl_b']);
  });

  it('[INV] a non-string id is dropped rather than bound into the statement', () => {
    const row = { name: 'x', appBlocks: [{ appListing: { id: 7 } }] } as never;
    expect(listingIdsInChipRow(row)).toEqual([]);
  });
});
