import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 🔴 THE SEAM: `getAppListingAuthoringContext` (server) → `editorTabsFor` (client).
 *
 * Both halves are hermetically tested already, and BOTH suites are green on a tree where
 * the owner-repair loop has no UI: `app-access.accessible-listings.test.ts` proves the
 * server projects `lastModerationAction`, and `appListingEditorTabs.test.ts` proves the tab
 * set branches on it — with a fixture the test wrote by hand. Neither ever builds the
 * COMBINED state, so neither can see the bit failing to travel: a rename, a normalisation
 * that flattens the distinction, or the page simply not passing the field would leave both
 * suites passing while the feature is dark. That is the defect class this file exists for,
 * and #4401's `messageAppOwner` (a live proc with zero UI callers, still dark) is the
 * worked example of it in this codebase.
 *
 * 🔴 IT PINS A RELATIONSHIP, NOT A COMPONENT: the REAL service (with its real query, its
 * real normalisation and its real fail-closed arms) feeding the REAL tab derivation. The
 * only thing faked is Postgres — and the moderation-event fake INTERPRETS the `where`
 * rather than returning a canned row, so the query's own `action: { in: … }` filter is
 * observable here. A canned fake would make the filter unobservable and every mutant to it
 * would pass.
 *
 * 🔴 WHY THE FILTER MATTERS AT THIS SEAM. `AppListingModerationEvent` is a moderator
 * ACTIVITY log, not a state log: `message-owner`, `report-resolve` / `report-dismiss` and
 * `claim` change no listing status. A moderator messaging an owner *"fix X and republish"*
 * — the most natural workflow this feature has — would otherwise push `message-owner` in
 * front of the owner's own `owner-unpublish` and silently revoke the repair tabs. The tab
 * gate has no way to notice; only the query's filter stops it.
 */

import { dbMock } from '~/__tests__/mocks/db.mock';
import { getAppListingAuthoringContext } from '~/server/services/blocks/app-access.service';
import { editorTabsFor } from '~/components/Apps/appListingEditorTabs';

/**
 * 🔴 NO PER-FILE MOCK OF THE DB CLIENT HERE — the CANONICAL shared mock, registered once in
 * `src/__tests__/setup.ts`, is used instead. A per-file db mock freezes its own partial shape
 * into every later file in the same worker under `--no-isolate`; `no-direct-shared-module-mock`
 * is the ratchet that stops a new one being added. See docs/testing/shared-module-mocks.md.
 * (That guard scans this file's TEXT, so it must not spell the specifier inside a mock call
 * even in prose — hence the wording.)
 */
const mockDb = dbMock.dbRead;
const mockWriteDb = dbMock.dbWrite;

const OWNER = 10;

type Event = { action: string; createdAt: number; id: string };

/**
 * A moderation-event table that EVALUATES the query's `where` + `orderBy` the way Postgres
 * would. It filters on `where.action.in` and sorts `createdAt desc, id desc` — the exact
 * two things `readLastModerationAction` relies on and the exact two a mutant would break.
 */
function withEvents(events: Event[]) {
  const impl = async (...a: unknown[]) => {
    const args = a[0] as {
      where: { appListingId: string; action?: { in?: string[] } };
      orderBy: unknown;
      select: { action: boolean };
    };
    const allowed = args.where.action?.in;
    const rows = events
      .filter((e) => allowed == null || allowed.includes(e.action))
      .sort((x, y) => y.createdAt - x.createdAt || y.id.localeCompare(x.id));
    return rows.length > 0 ? { action: rows[0].action } : null;
  };
  mockDb.appListingModerationEvent.findFirst.mockImplementation(impl);
  mockWriteDb.appListingModerationEvent.findFirst.mockImplementation(impl);
}

/** The two `findUnique` reads `getAppListingAuthoringContext` makes, discriminated by select. */
function withListing(status: string) {
  mockDb.appListing.findUnique.mockImplementation(async (...a: unknown[]) =>
    (a[0] as { select?: { connectClientId?: boolean } }).select?.connectClientId
      ? { id: 'apl_1', slug: 'my-app', name: 'My App', status, connectClientId: null }
      : {
          id: 'apl_1',
          userId: OWNER,
          kind: 'onsite',
          appBlockId: 'ab_1',
          revisionOfId: null,
          appBlock: { app: { userId: OWNER } },
          revisionOf: null,
        }
  );
}

/** The page's OWN derivation, verbatim — see `/apps/listing/[appListingId]/edit`. */
async function tabsForListing(status: string, events: Event[]) {
  withListing(status);
  withEvents(events);
  const ctx = await getAppListingAuthoringContext({ appListingId: 'apl_1', userId: OWNER });
  return {
    lastModerationAction: ctx.lastModerationAction,
    tabs: editorTabsFor({
      kind: ctx.kind,
      appBlockId: ctx.appBlockId,
      role: ctx.role,
      status: ctx.status,
      lastModerationAction: ctx.lastModerationAction,
      capabilities: ctx.capabilities,
    }),
  };
}

beforeEach(() => {
  // 🔴 PER-TEST, because `resetSharedMocks()` runs once per FILE. Without this the call-count
  // assertion in the approved case would count every earlier case's reads and pass (or fail)
  // for reasons unrelated to it.
  mockDb.appListing.findUnique.mockReset();
  mockDb.appListingModerationEvent.findFirst.mockReset();
  mockWriteDb.appListingModerationEvent.findFirst.mockReset();
  mockDb.appCollaborator.findFirst.mockReset();
  mockWriteDb.appCollaborator.findFirst.mockReset();
  mockDb.appCollaborator.findFirst.mockImplementation(async () => null);
  mockWriteDb.appCollaborator.findFirst.mockImplementation(async () => null);
});

describe('🔴 the owner-repair bit survives the whole trip: DB row → normalisation → tab set', () => {
  it('🔴 an OWNER self-unpublish ends with Details + Media actually offered', async () => {
    const { lastModerationAction, tabs } = await tabsForListing('removed', [
      { action: 'owner-unpublish', createdAt: 100, id: 'ev_1' },
    ]);
    // The intermediate value is asserted as well as the end state, so a failure says WHICH
    // half broke instead of only that the seam did.
    expect(lastModerationAction).toBe('owner-unpublish');
    expect(tabs).toEqual(['details', 'media', 'publishing', 'history']);
  });

  it('🔴 a MODERATOR takedown ends with them withheld — the same trip, opposite answer', async () => {
    const { lastModerationAction, tabs } = await tabsForListing('removed', [
      { action: 'owner-unpublish', createdAt: 100, id: 'ev_1' },
      { action: 'delist', createdAt: 200, id: 'ev_2' },
    ]);
    // Normalised on the way out, so the seated-editor disclosure boundary holds here too.
    expect(lastModerationAction).toBe('other');
    expect(tabs).toEqual(['publishing', 'history']);
  });

  it('🔴 a STATE-NEUTRAL event on top of the unpublish does NOT revoke the repair tabs', async () => {
    // The workflow the filter exists for: the owner takes the app down, a moderator then
    // messages them about it. `message-owner` is NEWER but changes no status, so it must not
    // displace the event that explains the removal. Driven over all four neutral verbs, each
    // strictly newer than the unpublish.
    for (const verb of ['message-owner', 'report-resolve', 'report-dismiss', 'claim'] as const) {
      const { lastModerationAction, tabs } = await tabsForListing('removed', [
        { action: 'owner-unpublish', createdAt: 100, id: 'ev_1' },
        { action: verb, createdAt: 300, id: 'ev_9' },
      ]);
      expect(lastModerationAction, verb).toBe('owner-unpublish');
      expect(tabs, verb).toEqual(['details', 'media', 'publishing', 'history']);
    }
  });

  it('🔴 a STATUS-CHANGING event on top of it DOES — the control for the case above', async () => {
    // Same shape, same ordering, one field different: `relist` is in the status-changing
    // half of the partition, so it legitimately displaces the unpublish. Without this arm
    // the neutral case above would also pass on an implementation that ignores the newest
    // event entirely.
    const { lastModerationAction, tabs } = await tabsForListing('removed', [
      { action: 'owner-unpublish', createdAt: 100, id: 'ev_1' },
      { action: 'relist', createdAt: 300, id: 'ev_9' },
    ]);
    expect(lastModerationAction).toBe('other');
    expect(tabs).toEqual(['publishing', 'history']);
  });

  it('🔴 NO events at all fails closed all the way to the tab set', async () => {
    const { lastModerationAction, tabs } = await tabsForListing('removed', []);
    expect(lastModerationAction).toBeNull();
    expect(tabs).toEqual(['publishing', 'history']);
  });

  it('🔴 the tie-break decides a same-timestamp pair, and it reaches the tabs', async () => {
    // Two events written in one transaction share a `createdAt`; `id desc` is what makes the
    // answer deterministic rather than planner-dependent. A non-deterministic answer here
    // flips the owner's content tabs on and off at random between page loads.
    const { tabs } = await tabsForListing('removed', [
      { action: 'owner-unpublish', createdAt: 100, id: 'ev_a' },
      { action: 'delist', createdAt: 100, id: 'ev_b' },
    ]);
    expect(tabs).toEqual(['publishing', 'history']);
  });

  it('🔴 an APPROVED listing never reads the event at all, and keeps the full set', async () => {
    // The control arm for the whole file: it proves the pipeline above is doing work on
    // `removed` specifically, and pins that a stale `owner-unpublish` on a relisted app costs
    // no round trip and changes nothing.
    const { lastModerationAction, tabs } = await tabsForListing('approved', [
      { action: 'owner-unpublish', createdAt: 100, id: 'ev_1' },
    ]);
    expect(lastModerationAction).toBeNull();
    expect(mockDb.appListingModerationEvent.findFirst).not.toHaveBeenCalled();
    expect(tabs).toEqual([
      'details',
      'media',
      'manifest',
      'earnings',
      'collaborators',
      'publishing',
      'history',
    ]);
  });
});
