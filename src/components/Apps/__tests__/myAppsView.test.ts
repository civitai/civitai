import { describe, expect, it } from 'vitest';

import {
  INACTIVE_LISTING_STATUSES,
  INACTIVE_PAGE_SIZE,
  isActionableOrphan,
  isInactiveListing,
  listingMediaIndex,
  listingMediaShots,
  myAppListingHref,
  orphanGroupStartsOpen,
  pageCount,
  pageSlice,
  partitionMyAppRows,
  sortByRecentlyUpdated,
} from '~/components/Apps/myAppsView';
import {
  canOpenListingAuthoringPage,
  capabilitiesForKind,
  LISTING_AUTHORING_ROUTE_STATUSES,
} from '~/shared/constants/app-capabilities.constants';
// 🔴 FROM ITS OWN MODULE, NOT RE-EXPORTED THROUGH THE ONE UNDER TEST. Importing it from
// `app-capabilities.constants` (which imports but does not re-export it) yields `undefined`,
// and `new Set(undefined)` is an EMPTY set — so the equality below would have been comparing
// the route list against nothing. It failed loudly here only because the other side is
// non-empty; written as `toContain` it would have passed vacuously forever. `tsconfig.json`
// excludes `src/**/__tests__/**`, so a green typecheck could not have caught the bad import.
import { APP_LISTING_STATUSES } from '~/server/services/blocks/app-listing-status.constants';

/**
 * `/apps/mine` view-model — the merged author table's partition, order and pagination.
 *
 * 🔴 THIS FILE IS IN THE **`unit`** PROJECT ON PURPOSE. The browser-mode `component`
 * project is report-only and gates nothing; `unit` is the tier whose verdict is read. The
 * rule this pins — which listing statuses are "inactive" — is pure logic, so it belongs
 * where it can actually block.
 *
 * Every fixture below uses a status/kind pair that is DISTINCT from every other fixture's
 * and from any literal an assertion names, so a mutant that hardcodes one of those literals
 * cannot survive by coincidence.
 */

type Row = { appListingId: string; status: string; updatedAt: string | Date };

const row = (appListingId: string, status: string, updatedAt: string): Row => ({
  appListingId,
  status,
  updatedAt,
});

describe('isInactiveListing — the LISTING-level terminal states, and only those', () => {
  it('the declared set is exactly {rejected, removed}', () => {
    // A value pin: the set IS the product decision, so growing or shrinking it silently is
    // the failure this catches.
    expect([...INACTIVE_LISTING_STATUSES].sort()).toEqual(['rejected', 'removed']);
  });

  it('rejected is inactive', () => {
    expect(isInactiveListing('rejected')).toBe(true);
  });

  it('removed is inactive', () => {
    expect(isInactiveListing('removed')).toBe(true);
  });

  it('draft is ACTIVE — it belongs in the main table, not the collapse', () => {
    expect(isInactiveListing('draft')).toBe(false);
  });

  it('pending is ACTIVE', () => {
    expect(isInactiveListing('pending')).toBe(false);
  });

  it('approved is ACTIVE', () => {
    expect(isInactiveListing('approved')).toBe(false);
  });

  /**
   * 🔴 THE CORE INVARIANT OF THE MERGE, stated as its own case so a mutant that adds
   * `'withdrawn'` to the set dies HERE, by name, rather than by tripping some neighbouring
   * assertion about draft or pending.
   *
   * `withdrawn` exists ONLY in the publish-request enum. `app_listings.status` cannot hold
   * it. A `withdrawn` submission is an event on an app; it says nothing about whether the
   * app is live, and an app whose owner withdrew one request is very often `approved` and
   * serving users. Treating it as a listing state would file healthy apps under "Inactive"
   * where they are collapsed away from their own owner by default.
   */
  it('🔴 withdrawn is NOT a listing status and must never partition an app as inactive', () => {
    expect(isInactiveListing('withdrawn')).toBe(false);
    expect(INACTIVE_LISTING_STATUSES as readonly string[]).not.toContain('withdrawn');
  });

  it('an unknown status is ACTIVE — fail OPEN, so a new state is visible not hidden', () => {
    expect(isInactiveListing('quarantined')).toBe(false);
  });
});

describe('partitionMyAppRows', () => {
  it('sends only the two terminal statuses to the collapse and keeps the rest in the table', () => {
    const rows = [
      row('apl_draft', 'draft', '2026-08-05T00:00:00Z'),
      row('apl_removed', 'removed', '2026-08-04T00:00:00Z'),
      row('apl_pending', 'pending', '2026-08-03T00:00:00Z'),
      row('apl_rejected', 'rejected', '2026-08-02T00:00:00Z'),
      row('apl_approved', 'approved', '2026-08-01T00:00:00Z'),
    ];
    const { active, inactive } = partitionMyAppRows(rows);
    expect(active.map((r) => r.appListingId)).toEqual(['apl_draft', 'apl_pending', 'apl_approved']);
    expect(inactive.map((r) => r.appListingId)).toEqual(['apl_removed', 'apl_rejected']);
  });

  /**
   * 🔴 DECISION #2, as a behavioural case. The partition reads the LISTING row and nothing
   * else — a row carrying a withdrawn (or rejected) SUBMISSION on an approved app stays
   * ACTIVE. The extra fields are here precisely so a partition that started consulting
   * history would fail.
   */
  it('🔴 an APPROVED app whose latest submission was withdrawn stays ACTIVE', () => {
    const rows = [
      {
        ...row('apl_live', 'approved', '2026-08-07T00:00:00Z'),
        latestSubmissionStatus: 'withdrawn',
      },
      { ...row('apl_gone', 'removed', '2026-08-06T00:00:00Z'), latestSubmissionStatus: 'approved' },
    ];
    const { active, inactive } = partitionMyAppRows(rows);
    expect(active.map((r) => r.appListingId)).toEqual(['apl_live']);
    expect(inactive.map((r) => r.appListingId)).toEqual(['apl_gone']);
  });

  it('preserves the incoming order within each group', () => {
    const rows = [
      row('c', 'approved', '2026-01-03T00:00:00Z'),
      row('a', 'approved', '2026-01-01T00:00:00Z'),
      row('b', 'approved', '2026-01-02T00:00:00Z'),
    ];
    expect(partitionMyAppRows(rows).active.map((r) => r.appListingId)).toEqual(['c', 'a', 'b']);
  });

  it('an empty input yields two empty groups, not undefined', () => {
    expect(partitionMyAppRows([])).toEqual({ active: [], inactive: [] });
  });
});

describe('sortByRecentlyUpdated', () => {
  it('orders newest-updated first regardless of the input order', () => {
    const rows = [
      row('mid', 'pending', '2026-03-15T12:00:00Z'),
      row('newest', 'draft', '2026-07-01T09:30:00Z'),
      row('oldest', 'approved', '2025-11-20T23:59:00Z'),
    ];
    expect(sortByRecentlyUpdated(rows).map((r) => r.appListingId)).toEqual([
      'newest',
      'mid',
      'oldest',
    ]);
  });

  it('accepts Date as well as ISO string', () => {
    const rows = [
      { appListingId: 'str', status: 'draft', updatedAt: '2026-02-01T00:00:00Z' },
      { appListingId: 'date', status: 'draft', updatedAt: new Date('2026-06-01T00:00:00Z') },
    ];
    expect(sortByRecentlyUpdated(rows).map((r) => r.appListingId)).toEqual(['date', 'str']);
  });

  it('breaks a tie by id so the order is stable across renders', () => {
    const rows = [
      row('zeta', 'pending', '2026-05-05T00:00:00Z'),
      row('alpha', 'removed', '2026-05-05T00:00:00Z'),
    ];
    expect(sortByRecentlyUpdated(rows).map((r) => r.appListingId)).toEqual(['alpha', 'zeta']);
  });

  it('an unparseable timestamp sorts LAST rather than poisoning the comparator', () => {
    const rows = [row('bad', 'draft', 'not-a-date'), row('good', 'draft', '2026-04-04T00:00:00Z')];
    expect(sortByRecentlyUpdated(rows).map((r) => r.appListingId)).toEqual(['good', 'bad']);
  });

  it('does not mutate its input', () => {
    const rows = [
      row('second', 'draft', '2026-01-01T00:00:00Z'),
      row('first', 'draft', '2026-09-09T00:00:00Z'),
    ];
    sortByRecentlyUpdated(rows);
    expect(rows.map((r) => r.appListingId)).toEqual(['second', 'first']);
  });
});

describe('Inactive collapse pagination', () => {
  it('the page size is a positive integer', () => {
    expect(Number.isInteger(INACTIVE_PAGE_SIZE)).toBe(true);
    expect(INACTIVE_PAGE_SIZE).toBeGreaterThan(0);
  });

  it('pageCount is never 0 — the control always has a page to be on', () => {
    expect(pageCount(0, 4)).toBe(1);
  });

  it('pageCount rounds UP on a partial last page', () => {
    // 9 over a page size of 4 is 3 pages (4 + 4 + 1) — the boundary a floor would drop.
    expect(pageCount(9, 4)).toBe(3);
    expect(pageCount(8, 4)).toBe(2);
  });

  it('pageSlice returns exactly one page, at the right offset', () => {
    const rows = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'];
    expect(pageSlice(rows, 1, 3)).toEqual(['r1', 'r2', 'r3']);
    expect(pageSlice(rows, 2, 3)).toEqual(['r4', 'r5', 'r6']);
  });

  it('🔴 the LAST page is the short one, not an empty one', () => {
    const rows = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'];
    expect(pageSlice(rows, 3, 3)).toEqual(['r7']);
  });

  it('a page past the end CLAMPS to the last page instead of stranding the user on blank', () => {
    const rows = ['r1', 'r2', 'r3', 'r4', 'r5'];
    expect(pageSlice(rows, 99, 2)).toEqual(['r5']);
  });

  it('a page below 1 clamps to the first page', () => {
    const rows = ['r1', 'r2', 'r3'];
    expect(pageSlice(rows, 0, 2)).toEqual(['r1', 'r2']);
  });
});

describe('myAppListingHref — per-row, per-kind, never one flat link', () => {
  it('an ON-SITE row with a block lands on the listing-keyed editor', () => {
    expect(
      myAppListingHref({
        appListingId: 'apl_on',
        kind: 'onsite',
        appBlockId: 'ab_9',
        role: 'owner',
        status: 'approved',
        capabilities: capabilitiesForKind('onsite'),
      })
    ).toBe('/apps/listing/apl_on/edit?tab=details');
  });

  it('an OFF-SITE row (no block) still lands on the SAME canonical route', () => {
    // Listing-keyed, not block-keyed: an off-site listing has no block id to build a
    // `/apps/<appBlockId>/…` href with at all.
    expect(
      myAppListingHref({
        appListingId: 'apl_off',
        kind: 'offsite',
        appBlockId: null,
        role: 'editor',
        status: 'draft',
        capabilities: capabilitiesForKind('offsite'),
      })
    ).toBe('/apps/listing/apl_off/edit?tab=details');
  });

  it('the listing id is URL-encoded', () => {
    expect(
      myAppListingHref({
        appListingId: 'apl a/b',
        kind: 'onsite',
        appBlockId: 'ab_1',
        role: 'owner',
        status: 'pending',
        capabilities: capabilitiesForKind('onsite'),
      })
    ).toContain('/apps/listing/apl%20a%2Fb/edit');
  });
});

/**
 * 🔴 THE ROW'S FIRST TAB IS NO LONGER ALWAYS `details`, and that is this PR.
 *
 * `/apps/mine` no longer carries the History disclosure or the Unpublish/Republish pair, so
 * the row's link is the author's only route to either. It therefore has to land on a tab
 * that EXISTS for that row — `editorTabsFor` is what decides, and these cases pin that the
 * href follows it rather than hardcoding a default the destination would silently rewrite.
 */
describe('🔴 myAppListingHref follows the STATUS-narrowed tab set', () => {
  const base = {
    appListingId: 'apl_h',
    kind: 'onsite',
    appBlockId: 'ab_h',
    role: 'owner',
    capabilities: capabilitiesForKind('onsite'),
    // 🔴 SPELLED, and `null` is the fail-closed value ("not proven to be the owner's own").
    // The field is REQUIRED on this row type; leaving fixtures to omit it is precisely the
    // ergonomics decision that let the production caller drop it.
    lastModerationAction: null,
  } as const;

  it('an owner on a MODERATOR-removed listing lands on Publishing — their route back', () => {
    // `lastModerationAction: null` reads as a moderator removal (fail-closed), so the tab
    // set is the narrowed publishing/history pair and `tabs[0]` is Publishing.
    expect(myAppListingHref({ ...base, status: 'removed' })).toBe(
      '/apps/listing/apl_h/edit?tab=publishing'
    );
  });

  /**
   * 🔴 THE BEHAVIOURAL CASE FOR THE DROPPED-FIELD DEFECT — and the reason a structural
   * guard is not enough on its own.
   *
   * `appListingEditorTabs.callers.test.ts` asserts that every call site PASSES
   * `lastModerationAction`. That is a claim about the argument list, and a structural check
   * like it type-checks straight past a WRONG argument — passing the field but reading it
   * off the wrong object, or hardcoding it, would satisfy the ledger completely. This pins
   * the OUTCOME instead: the same listing, distinguished only by the moderation action,
   * must produce a DIFFERENT href.
   *
   * It is also the user-visible half of the defect. While the field was dropped, an
   * owner-unpublished listing produced `?tab=publishing` from this function while the
   * authoring page offered `details` + `media` for the very same row — two surfaces
   * disagreeing about one listing.
   */
  it('🔴 an OWNER-unpublished listing lands on Details — the row now agrees with the page', () => {
    expect(
      myAppListingHref({ ...base, status: 'removed', lastModerationAction: 'owner-unpublish' })
    ).toBe('/apps/listing/apl_h/edit?tab=details');
  });

  it('🔴 the pair DIFFERS on the moderation action alone — one field, two answers', () => {
    // The discriminating control. Both fixtures are `removed`, same kind, same role, same
    // capabilities; only `lastModerationAction` moves. A mutant that ignores the field
    // makes these two equal, and this is the assertion that says so directly.
    const modRemoved = myAppListingHref({ ...base, status: 'removed' });
    const ownerUnpublished = myAppListingHref({
      ...base,
      status: 'removed',
      lastModerationAction: 'owner-unpublish',
    });
    expect(modRemoved).not.toBe(ownerUnpublished);
  });

  it('an owner on a REJECTED listing lands on History — a different answer, same branch', () => {
    expect(myAppListingHref({ ...base, status: 'rejected' })).toBe(
      '/apps/listing/apl_h/edit?tab=history'
    );
  });

  it('🔴 an EDITOR on a removed listing lands on History — the page SERVES them, owner-only is only Publishing', () => {
    expect(myAppListingHref({ ...base, status: 'removed', role: 'editor' })).toBe(
      '/apps/listing/apl_h/edit?tab=history'
    );
  });
});

/**
 * 🔴 THE ROW'S LINK PREDICATE IS `canOpenListingAuthoringPage` AND NOTHING ELSE — no role
 * clause. An earlier draft of this PR had one, withholding the link from a seated EDITOR on
 * a removed listing and justifying it in a TEST NAME as "`getAppListingAuthoringContext`
 * refuses them there". It does not. `resolveListingAccess` returns `role:'editor'` for any
 * accepted seat regardless of the listing's status, and the authoring context refuses only
 * on a missing role or a status outside the route set. The server serves that editor a
 * History-only page.
 *
 * That test name is the reason this note is long: a name asserting a server refusal that
 * does not exist is worse than no test, because the next person to simplify the predicate
 * reasons from it. The role clause was also an unannounced regression — the pre-PR row
 * rendered its History toggle unconditionally, so a seated editor could reach a removed
 * app's history from `/apps/mine`. The predicate below restores that.
 */
describe('canOpenListingAuthoringPage — the row link rule, and the only rule', () => {
  it('opens on every listing status the lifecycle can mint', () => {
    for (const status of ['draft', 'pending', 'approved', 'removed', 'rejected']) {
      expect(canOpenListingAuthoringPage(status), status).toBe(true);
    }
  });

  it('🔴 an UNKNOWN status never opens — fail closed', () => {
    // `'quarantined'` is not a prefix or suffix of any real status, so it cannot match one
    // by accident. This is the sole cause of a `false`, which is what makes the membership
    // test individually killable.
    expect(canOpenListingAuthoringPage('quarantined')).toBe(false);
    expect(canOpenListingAuthoringPage('')).toBe(false);
  });

  /**
   * 🔴 THE CONSTANT IS A HAND-COPY OF THE DB CHECK'S VALUE SPACE, so it is pinned to the
   * one that already has a migration-agreement test rather than restated a third time.
   * Without this, adding a sixth lifecycle status silently FORBIDs the authoring page for
   * that whole cohort — fail-closed, but a total outage for it, with nothing going red.
   *
   * The set-equality direction matters both ways: a status missing here is that outage, and
   * a status here that the DB cannot store is a branch no fixture can reach.
   */
  it('🔴 covers EXACTLY the app_listings.status value space', () => {
    expect(new Set<string>(LISTING_AUTHORING_ROUTE_STATUSES)).toEqual(
      new Set<string>(APP_LISTING_STATUSES)
    );
  });
});

/**
 * 🔴 THE `MY_APPS_CONTAINER_SIZE` BLOCK THAT LIVED HERE IS DELETED WITH THE CONSTANT.
 *
 * It aliased `APPS_PAGE_WIDTHS['/apps/mine']` so the page could hand a per-page width to
 * `AppsPageLayout size=`. That prop is gone — every `/apps/*` route renders in the one
 * `APPS_PAGE_CONTAINER_WIDTH` container, because the shared sub-nav lived inside the
 * per-page box and moved horizontally between routes.
 *
 * Its assertions are not merely dropped. `> 1100` was a weak proxy for "this page is wide
 * enough for its table" — it could not have noticed the container falling to 1400, which
 * would have re-opened the clip. The real relationship,
 * `APPS_PAGE_CONTAINER_WIDTH − SUBMISSIONS_CONTAINER_CHROME > SUBMISSIONS_TABLE_MIN_WIDTH`,
 * is asserted in `appsPageWidths.test.ts` together with the counterfactual that the
 * readable measure would NOT clear that floor.
 */

/* ------------------------------------------------------------------ *
 * The row's two images, as ONE viewer list
 * ------------------------------------------------------------------ */

/**
 * 🔴 THESE TWO FUNCTIONS ARE A PAIR, AND THE PAIRING IS WHAT IS PINNED.
 *
 * `listingMediaShots` decides the ORDER; `listingMediaIndex` answers "where is the one
 * that was clicked". A disagreement between them opens the WRONG picture — the icon's
 * click landing on the cover — and nothing errors, nothing looks broken, and no
 * rendering test that only checks "a viewer opened" can see it. So every case below
 * asserts the two against each other, not just each on its own.
 */
describe('listingMediaShots / listingMediaIndex — the row media viewer list', () => {
  const media = (
    name: string,
    coverUrl: string | null,
    iconUrl: string | null
  ): { name: string; coverUrl: string | null; iconUrl: string | null } => ({
    name,
    coverUrl,
    iconUrl,
  });

  it('COVER FIRST, then the icon — both present', () => {
    // Pairwise-distinct urls and a name that appears in neither, so a mutant returning
    // the wrong url (or the same url twice) cannot pass by coincidence.
    const row = media('Zephyr', 'https://cdn/cover-a.png', 'https://cdn/icon-b.png');
    expect(listingMediaShots(row)).toEqual([
      { url: 'https://cdn/cover-a.png', caption: 'Zephyr cover image' },
      { url: 'https://cdn/icon-b.png', caption: 'Zephyr icon' },
    ]);
    expect(listingMediaIndex(row, 'cover')).toBe(0);
    expect(listingMediaIndex(row, 'icon')).toBe(1);
  });

  it('🔴 the icon SHIFTS TO 0 when there is no cover — the index is positional', () => {
    const row = media('Quill', null, 'https://cdn/icon-c.png');
    expect(listingMediaShots(row)).toEqual([
      { url: 'https://cdn/icon-c.png', caption: 'Quill icon' },
    ]);
    // The whole reason the index is computed rather than assumed: with the cover gone,
    // the icon is entry 0, and an implementation that returned a fixed 1 would open a
    // viewer on an index that does not exist.
    expect(listingMediaIndex(row, 'icon')).toBe(0);
    expect(listingMediaIndex(row, 'cover')).toBeNull();
  });

  it('a cover with no icon keeps the cover at 0', () => {
    const row = media('Harbor', 'https://cdn/cover-d.png', null);
    expect(listingMediaShots(row)).toEqual([
      { url: 'https://cdn/cover-d.png', caption: 'Harbor cover image' },
    ]);
    expect(listingMediaIndex(row, 'cover')).toBe(0);
    expect(listingMediaIndex(row, 'icon')).toBeNull();
  });

  it('🔴 neither image → an EMPTY list and null for both, so nothing is clickable', () => {
    const row = media('Vellum', null, null);
    expect(listingMediaShots(row)).toEqual([]);
    expect(listingMediaIndex(row, 'cover')).toBeNull();
    expect(listingMediaIndex(row, 'icon')).toBeNull();
  });

  /**
   * 🔴 THE CASE A `findIndex(s => s.url === url)` IMPLEMENTATION GETS WRONG. When a
   * listing's icon and cover are the SAME url, a url lookup collapses both to entry 0,
   * so clicking the icon opens the cover — and because the pixels are identical, it
   * looks correct. Only the position can tell them apart.
   */
  it('🔴 identical icon and cover urls are still TWO distinct positions', () => {
    const same = 'https://cdn/same-image.png';
    const row = media('Twin', same, same);
    expect(listingMediaShots(row)).toHaveLength(2);
    expect(listingMediaIndex(row, 'cover')).toBe(0);
    expect(listingMediaIndex(row, 'icon')).toBe(1);
  });

  it('every returned index really addresses an entry in the list it is paired with', () => {
    // The relationship, quantified over every media shape rather than the four above.
    for (const cover of ['https://cdn/c.png', null]) {
      for (const icon of ['https://cdn/i.png', null]) {
        const row = media('Atlas', cover, icon);
        const shots = listingMediaShots(row);
        for (const which of ['cover', 'icon'] as const) {
          const idx = listingMediaIndex(row, which);
          const url = which === 'cover' ? cover : icon;
          if (url === null) {
            expect(idx, `${which} absent → null`).toBeNull();
          } else {
            expect(idx, `${which} present → an index`).not.toBeNull();
            expect(shots[idx as number]?.url, `${which} @ ${idx}`).toBe(url);
          }
        }
      }
    }
  });

  it('every caption is non-empty — the viewer uses it as the image accessible name', () => {
    // `AppListingScreenshotViewer` sets `alt=""` whenever a caption is present (the
    // caption renders as visible text beside the image), so an empty caption would
    // leave the image unnamed rather than merely uncaptioned.
    const shots = listingMediaShots(media('Ridge', 'https://cdn/c.png', 'https://cdn/i.png'));
    for (const s of shots) {
      expect(s.caption ?? '').not.toBe('');
      expect(s.caption).toContain('Ridge');
    }
  });
});

/* ------------------------------------------------------------------ *
 * Which orphaned submissions are ACTIONABLE
 * ------------------------------------------------------------------ */

/**
 * 🔴 THIS PREDICATE IS THE ONLY THING CARRYING FORWARD A MEASURED GUARANTEE. The
 * "Submissions without a listing" group is now collapsible; before, it was
 * unconditionally visible because it is the ONLY surface showing a rejection reason and
 * the "your app was rejected" notification deep-links to this page (production
 * 2026-08-20: 3 of 3 rejected and 27 of 33 withdrawn on-site requests were otherwise
 * unreachable). Collapsing it is only safe because this returns `true` for exactly the
 * rows those reasons are about. A mutant that narrows it re-hides a rejection.
 */
describe('isActionableOrphan / orphanGroupStartsOpen', () => {
  const orphan = (over: Partial<Parameters<typeof isActionableOrphan>[0]> = {}) => ({
    status: 'approved',
    rejectionReason: null,
    canWithdraw: false,
    ...over,
  });

  it('🔴 a REJECTION REASON is actionable — it is the only text saying what to fix', () => {
    expect(
      isActionableOrphan(orphan({ status: 'rejected', rejectionReason: 'scope never used' }))
    ).toBe(true);
  });

  it('🔴 a rejection reason is actionable on ANY status, not only `rejected`', () => {
    // The reason is the signal, not the status word — a withdrawn request that was
    // reviewed first still carries the reviewer's note, and it is still the only copy.
    expect(
      isActionableOrphan(orphan({ status: 'withdrawn', rejectionReason: 'missing icon' }))
    ).toBe(true);
  });

  it('🔴 PENDING + the server says withdrawable → actionable (a decision still open)', () => {
    expect(isActionableOrphan(orphan({ status: 'pending', canWithdraw: true }))).toBe(true);
  });

  it('🔴 BOTH halves of the pending rule are required', () => {
    // pending but NOT withdrawable — the server's own refusal, mirrored. Offering the
    // group open here would promise an action that 403s.
    expect(isActionableOrphan(orphan({ status: 'pending', canWithdraw: false }))).toBe(false);
    // withdrawable-looking but NOT pending — a decided request cannot be withdrawn.
    expect(isActionableOrphan(orphan({ status: 'approved', canWithdraw: true }))).toBe(false);
    expect(isActionableOrphan(orphan({ status: 'rejected', canWithdraw: true }))).toBe(false);
  });

  it('an ABSENT canWithdraw is read as false — the safe direction', () => {
    const { canWithdraw: _drop, ...noFlag } = orphan({ status: 'pending' });
    expect(isActionableOrphan(noFlag)).toBe(false);
  });

  it('🔴 a WHITESPACE-ONLY reason is not a reason', () => {
    // `rejectionReason: ' '` renders as an empty red line. Treating it as actionable
    // would open the group on nothing at all.
    expect(isActionableOrphan(orphan({ status: 'rejected', rejectionReason: '   ' }))).toBe(false);
    expect(isActionableOrphan(orphan({ status: 'rejected', rejectionReason: '' }))).toBe(false);
  });

  it('settled history is NOT actionable', () => {
    expect(isActionableOrphan(orphan({ status: 'withdrawn' }))).toBe(false);
    expect(isActionableOrphan(orphan({ status: 'approved' }))).toBe(false);
    expect(isActionableOrphan(orphan({ status: 'rejected' }))).toBe(false);
  });

  it('🔴 the group opens if ANY row is actionable, not only the first', () => {
    // A `rows[0]`-only mutant passes a one-row fixture and every "first row" fixture.
    // The actionable row is LAST here, behind two settled ones.
    const rows = [
      orphan({ status: 'withdrawn' }),
      orphan({ status: 'approved' }),
      orphan({ status: 'pending', canWithdraw: true }),
    ];
    expect(orphanGroupStartsOpen(rows)).toBe(true);
  });

  it('all-settled → CLOSED, and an empty list → CLOSED', () => {
    expect(
      orphanGroupStartsOpen([orphan({ status: 'withdrawn' }), orphan({ status: 'approved' })])
    ).toBe(false);
    expect(orphanGroupStartsOpen([])).toBe(false);
  });
});
