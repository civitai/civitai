import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 🔴 THE VISIBILITY WRITE PATH — BEHAVIOURAL, because a mutation here is a PRIVILEGE
 * ESCALATION and the module had no test file at all.
 *
 * ── WHY STRUCTURAL LEDGERS WERE NOT ENOUGH ──────────────────────────────────────
 * The module was pinned only by two structural guards: a prose entry in
 * `app-access.call-site-ledger.test.ts` and a lexical scan in the catalog-bust ledger.
 * Neither executes a line of it. A mutation sweep accordingly found six survivors, and the
 * first is the whole authorization gate:
 *
 *   · weakening `if (!access || access.role == null)` to a condition that admits a
 *     role-less caller — ANY authenticated app developer could then set the level on ANY
 *     listing;
 *   · deleting the D1 status gate — an owner sets a level on a `removed` listing, i.e. the
 *     partial un-takedown every docblock in this feature says is impossible;
 *   · deleting the suspended-block half of D1;
 *   · widening the compare-and-set `WHERE` to admit `removed`/`rejected`, so the
 *     concurrent-takedown race loses silently;
 *   · making the OWNER path write a moderation event attributed to the owner;
 *   · making `assertVisibilityWritable` never refuse.
 *
 * Every case below is the behavioural half of one of those. A structural check type-checks
 * past a wrong argument; only driving the function can see a wrong decision.
 *
 * ⚠️ LABELS. `[NEW]` is behaviour this change introduces; `[INV]` is a property a later
 * edit could break. None of it is regression coverage against a base ref — the module does
 * not exist there, so these cases fail to IMPORT rather than going red.
 *
 * The CANONICAL shared db mock is used, not a per-file mock of the client module —
 * `no-direct-shared-module-mock` is the ratchet that stops a new one being added.
 */

vi.mock('~/server/services/blocks/app-listing.service', () => ({
  bustAppListingCatalogCache: vi.fn(async () => undefined),
}));

const { mockResolveListingAccess } = vi.hoisted(() => ({
  mockResolveListingAccess: vi.fn(
    async (..._a: unknown[]): Promise<unknown> => ({
      role: 'owner',
    })
  ),
}));
vi.mock('~/server/services/blocks/app-access.service', () => ({
  resolveListingAccess: (...a: unknown[]) => mockResolveListingAccess(...a),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { APP_LISTING_MODERATION_ACTIONS } from '~/server/schema/blocks/offsite-moderation.schema';
import {
  SET_VISIBILITY_ACTION,
  setListingVisibilityAsModerator,
  setListingVisibilityAsOwner,
  VISIBILITY_BLOCK_SUSPENDED_MESSAGE,
  VISIBILITY_EXCEEDS_REVIEW_CEILING_MESSAGE,
  VISIBILITY_NOT_OWNED_MESSAGE,
  VISIBILITY_STATUS_INELIGIBLE_MESSAGE,
} from '~/server/services/blocks/app-listing-visibility-write.service';
import { VISIBILITY_UNAVAILABLE_MESSAGE } from '~/server/services/blocks/app-listing-visibility.service';
import { maxVisibilityForStatus } from '~/shared/utils/app-listing-visibility';

const listing = dbMock.dbWrite.appListing;

/** The row the status read returns. Set per case. */
let row: Record<string, unknown> | null;
/** What the guarded level read answers. Set per case. */
let stored: string | null | 'THROW_P2022';
/** What the raw compare-and-set reports as its affected-row count. Set per case. */
let flipped: number;

/** The shape the shared mock's nodes expose, so a cast reads once rather than inline. */
type MockFn = { mockImplementation: (f: (...a: unknown[]) => unknown) => void };

function installDefaults() {
  row = { id: 'apl_1', slug: 'an-app', status: 'approved', appBlock: { status: 'approved' } };
  stored = null;
  flipped = 1;
  // The Prisma delegate answers the STATUS read and the post-CAS existence probe only. It
  // can no longer answer for the level: the column is `// @no-type`, so the field does not
  // exist on the generated client at all — which is the fix this suite now has to model.
  listing.findUnique.mockImplementation(async (args: unknown) => {
    const select = (args as { select?: Record<string, unknown> })?.select ?? {};
    if ('status' in select) return row;
    return row ? { id: 'apl_1' } : null;
  });
  // 🔴 THE LEVEL IS READ THROUGH `$queryRaw` AND WRITTEN THROUGH `$executeRaw`, so the
  // fakes are keyed on the STATEMENT rather than on a delegate method. A P2022 from the
  // read is what an unapplied migration produces.
  (dbMock.dbWrite.$queryRaw as unknown as MockFn).mockImplementation(async () => {
    if (stored === 'THROW_P2022') {
      throw Object.assign(new Error('column does not exist'), { code: 'P2022' });
    }
    return [{ visibility: stored }];
  });
  (dbMock.dbWrite.$executeRaw as unknown as MockFn).mockImplementation(async () => flipped);
  mockResolveListingAccess.mockImplementation(async () => ({ role: 'owner', seatListingId: 'apl_1' }));
  // 🔴 THE MODERATION-EVENT CREATE IS RESET HERE TOO, and omitting it cost a debugging round.
  // `clearAllMocks` clears CALLS but not IMPLEMENTATIONS (see `beforeEach`), so the case that
  // makes `create` THROW — modelling the 23514 the action CHECK produced in production — left
  // a throwing implementation installed for every case after it, and the next test failed
  // with that error rather than its own assertion. Every override this file installs must be
  // reinstalled here; that is the file's own convention and this one was the exception.
  (dbMock.dbWrite.appListingModerationEvent.create as unknown as MockFn).mockImplementation(
    async () => ({ id: 'almev_1' })
  );
}

beforeEach(() => {
  // `clearAllMocks` clears CALLS but not IMPLEMENTATIONS, so every override is reinstalled
  // explicitly rather than inherited from whichever case ran last.
  vi.clearAllMocks();
  installDefaults();
});

describe('the OWNER path — authorization', () => {
  it('[INV] a caller with NO ROLE is refused, and nothing is written', async () => {
    // 🔴 THE AUTHZ MUTANT. Weakening this condition lets any authenticated app developer
    // set the level on any listing.
    mockResolveListingAccess.mockImplementation(async () => null);
    await expect(
      setListingVisibilityAsOwner({ appListingId: 'apl_1', visibility: 'testers', userId: 9 })
    ).rejects.toThrow(VISIBILITY_NOT_OWNED_MESSAGE);
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('[INV] a row that resolves with a NULL role is refused', async () => {
    // The other shape `resolveListingAccess` can return: a row exists but the caller holds
    // no accepted seat on it. `{ role: null }` must be refused exactly like `null`.
    mockResolveListingAccess.mockImplementation(async () => ({ role: null, seatListingId: 'apl_1' }));
    await expect(
      setListingVisibilityAsOwner({ appListingId: 'apl_1', visibility: 'testers', userId: 9 })
    ).rejects.toThrow(VISIBILITY_NOT_OWNED_MESSAGE);
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('[INV] a MISSING listing and an UNOWNED one are indistinguishable', async () => {
    // Otherwise the proc is an existence oracle over listing ids. Both must produce the
    // SAME message, so the refusal carries no information about whether the row exists.
    mockResolveListingAccess.mockImplementation(async () => null);
    const unowned = await setListingVisibilityAsOwner({
      appListingId: 'apl_1',
      visibility: 'testers',
      userId: 9,
    }).catch((e: Error) => e.message);
    const missing = await setListingVisibilityAsOwner({
      appListingId: 'apl_nope',
      visibility: 'testers',
      userId: 9,
    }).catch((e: Error) => e.message);
    expect(unowned).toBe(missing);
  });

  it('[NEW] an accepted EDITOR may set the level, not only the owner', async () => {
    mockResolveListingAccess.mockImplementation(async () => ({ role: 'editor', seatListingId: 'apl_1' }));
    await expect(
      setListingVisibilityAsOwner({ appListingId: 'apl_1', visibility: 'testers', userId: 9 })
    ).resolves.toMatchObject({ visibility: 'testers', changed: true });
  });

  it('[INV] the role resolve reads the PRIMARY, so a just-accepted seat is visible', async () => {
    await setListingVisibilityAsOwner({ appListingId: 'apl_1', visibility: 'testers', userId: 9 });
    const [, , db] = mockResolveListingAccess.mock.calls[0] as [string, number, unknown];
    expect(db).toBe(dbMock.dbWrite);
  });

  it('[INV] the OWNER path writes NO moderation event', async () => {
    // 🔴 THIS CASE HAD **NO ASSERTION AT ALL** AND IS THE REASON TO DISTRUST A GREEN FILE.
    // It called the function and asserted nothing — no `expect`, no `expect.hasAssertions()`,
    // and the file carried no moderation-event mock to assert against. A faithful mutant
    // (an `appListingModerationEvent.create` on the write path, the shape
    // `offsite-moderation.service.ts` uses) SURVIVED the whole file, while the file header
    // claimed every case here was the behavioural half of a killed mutant. That claim was
    // false for this one.
    //
    // ⚠️ AND A CRUDER MUTANT DIED FOR THE WRONG REASON — a `create` placed where the shared
    // db mock had no default threw `Cannot read properties of undefined (reading 'catch')`,
    // i.e. the harness refusing a shape rather than an assertion firing. So the node is
    // given an explicit default below, which is what makes the red attributable.
    //
    // The property: an owner editing their own listing is an ordinary authored edit.
    // Attributing a moderation event to them would put owner actions into the MODERATOR
    // audit trail — and the deferred moderator path is the only thing that may write there.
    const events = dbMock.dbWrite.appListingModerationEvent;
    (events.create as unknown as MockFn).mockImplementation(async () => ({ id: 'alme_1' }));
    await setListingVisibilityAsOwner({ appListingId: 'apl_1', visibility: 'testers', userId: 9 });
    expect(events.create).not.toHaveBeenCalled();
    // The write itself DID happen, so the zero above is a measurement rather than a
    // function that returned early.
    expect(dbMock.dbWrite.$executeRaw).toHaveBeenCalledTimes(1);
  });
});

describe('D1 — the status gate', () => {
  it.each(['removed', 'rejected'])(
    '[INV] %s is refused, and nothing is written',
    async (status) => {
      // 🔴 THE PARTIAL UN-TAKEDOWN. Deleting this gate is a surviving mutant, and it is the
      // H1 hazard the whole feature is shaped around.
      row = { id: 'apl_1', slug: 'an-app', status, appBlock: { status: 'suspended' } };
      await expect(
        setListingVisibilityAsOwner({ appListingId: 'apl_1', visibility: 'public', userId: 9 })
      ).rejects.toThrow(VISIBILITY_STATUS_INELIGIBLE_MESSAGE);
      expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
    }
  );

  it('[INV] a `removed` listing is refused even with a role on it', async () => {
    // D1 is a decision about which listings carry a level, not about who may set one. A
    // taken-down listing's only path is private-run, for everyone — including, when the
    // deferred moderator proc lands, a moderator.
    row = { id: 'apl_1', slug: 'an-app', status: 'removed', appBlock: null };
    await expect(
      setListingVisibilityAsOwner({ appListingId: 'apl_1', visibility: 'public', userId: 9 })
    ).rejects.toThrow(VISIBILITY_STATUS_INELIGIBLE_MESSAGE);
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('[INV] a SUSPENDED backing block is refused even when the listing status is fine', async () => {
    // 🔴 THE SECOND HALF OF D1, also a surviving mutant. "Levels apply to non-suspended
    // listings only" is a claim about the APP, not only about the listing row — and a block
    // can be suspended through a path that leaves the row's status alone.
    row = { id: 'apl_1', slug: 'an-app', status: 'approved', appBlock: { status: 'suspended' } };
    await expect(
      setListingVisibilityAsOwner({ appListingId: 'apl_1', visibility: 'public', userId: 9 })
    ).rejects.toThrow(VISIBILITY_BLOCK_SUSPENDED_MESSAGE);
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('[INV] the two D1 refusals are DISTINCT messages', async () => {
    // So a mutant that swaps one gate for the other is killed by the message rather than
    // merely by "something threw" — the pair is how a test tells them apart.
    expect(VISIBILITY_STATUS_INELIGIBLE_MESSAGE).not.toBe(VISIBILITY_BLOCK_SUSPENDED_MESSAGE);
  });

  it.each(['draft', 'pending', 'approved'])('[NEW] %s is eligible', async (status) => {
    row = { id: 'apl_1', slug: 'an-app', status, appBlock: null };
    await expect(
      setListingVisibilityAsOwner({ appListingId: 'apl_1', visibility: 'moderators', userId: 9 })
    ).resolves.toMatchObject({ changed: true });
  });

  it('[INV] neither refusal names the status — not an oracle over lifecycle state', async () => {
    for (const s of ['removed', 'rejected']) {
      expect(VISIBILITY_STATUS_INELIGIBLE_MESSAGE).not.toContain(s);
    }
  });
});

describe('the REVIEW CEILING', () => {
  it.each(['draft', 'pending'])(
    '[NEW] %s refuses a level wider than `moderators`',
    async (status) => {
      // 🔴 THE MODERATOR-REVIEW BYPASS THIS CLOSES. Without the ceiling an owner could set
      // `public` on a never-reviewed listing and the anon-capable catalog endpoints would
      // serve its unreviewed name, URL and self-declared content rating.
      row = { id: 'apl_1', slug: 'an-app', status, appBlock: null };
      for (const tooWide of ['testers', 'public'] as const) {
        await expect(
          setListingVisibilityAsOwner({ appListingId: 'apl_1', visibility: tooWide, userId: 9 })
        ).rejects.toThrow(VISIBILITY_EXCEEDS_REVIEW_CEILING_MESSAGE);
      }
      expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
      // POSITIVE CONTROL: the ceiling itself is reachable, so the refusals above are the
      // ceiling and not a blanket refusal on unreviewed listings.
      await expect(
        setListingVisibilityAsOwner({ appListingId: 'apl_1', visibility: 'moderators', userId: 9 })
      ).resolves.toMatchObject({ changed: true });
    }
  );

  it('[INV] D7 is a property of the LISTING, not of the caller', () => {
    // The ceiling is keyed on review state alone — `maxVisibilityForStatus` takes a status
    // and nothing else — so it cannot be made caller-dependent without changing its
    // signature. That matters for the DEFERRED moderator proc: when it lands it inherits
    // this ceiling automatically, and a moderator who wants a draft public must approve it
    // rather than relabelling it, or the level becomes a second unaudited approval path.
    expect(maxVisibilityForStatus('draft')).toBe('moderators');
    expect(maxVisibilityForStatus('approved')).toBe('public');
  });

  it('[NEW] an APPROVED listing accepts every level — the ceiling is `public` there', async () => {
    row = { id: 'apl_1', slug: 'an-app', status: 'approved', appBlock: null };
    for (const v of ['private', 'moderators', 'testers', 'public'] as const) {
      stored = null;
      await expect(
        setListingVisibilityAsOwner({ appListingId: 'apl_1', visibility: v, userId: 9 })
      ).resolves.toMatchObject({ visibility: v, changed: true });
    }
  });

  it('[INV] the ceiling refusal is DISTINCT from both D1 refusals', async () => {
    // So a mutant swapping one gate for another is killed by the message rather than by
    // "something threw". Unlike the D1 messages this one deliberately NAMES the remedy,
    // because the caller can act on it.
    expect(VISIBILITY_EXCEEDS_REVIEW_CEILING_MESSAGE).not.toBe(
      VISIBILITY_STATUS_INELIGIBLE_MESSAGE
    );
    expect(VISIBILITY_EXCEEDS_REVIEW_CEILING_MESSAGE).not.toBe(VISIBILITY_BLOCK_SUSPENDED_MESSAGE);
  });
});

describe('the compare-and-set write', () => {
  it('[INV] the WHERE re-asserts the ELIGIBLE statuses, derived not hardcoded', async () => {
    // 🔴 A SURVIVING MUTANT WIDENED THIS TO ADMIT `removed`/`rejected`. The `where` is the
    // only thing that makes a concurrent takedown win the race, so it must carry the same
    // allowlist the pre-read used — and it must be DERIVED, or a grown allowlist leaves
    // `updateMany` matching zero rows and the refusal surfacing from the concurrency
    // branch, i.e. a stale allowlist misreported as a race.
    await setListingVisibilityAsOwner({ appListingId: 'apl_1', visibility: 'testers', userId: 9 });
    const call = (
      dbMock.dbWrite.$executeRaw as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.at(-1);
    const stmt = call?.[0] as { sql: string; values: unknown[] };
    // The statuses ride as BOUND VALUES, derived from the shared allowlist rather than
    // written a second time — a hardcoded list here would drift from the read's allowlist
    // and surface as a phantom concurrency refusal.
    expect(stmt.values).toEqual(['testers', 'apl_1', 'draft', 'pending', 'approved']);
    // Both halves of D1 are re-asserted inside the write.
    expect(stmt.sql).toContain('"status" IN');
    expect(stmt.sql).toContain(`ab."status" <> 'suspended'`);
  });

  it('[INV] zero matched rows is a REFUSAL, never a reported success', async () => {
    // The losing side of the race must be loud. Collapsing this into success would report
    // a level change on a listing that was taken down a millisecond earlier.
    flipped = 0;
    await expect(
      setListingVisibilityAsOwner({ appListingId: 'apl_1', visibility: 'testers', userId: 9 })
    ).rejects.toThrow(VISIBILITY_STATUS_INELIGIBLE_MESSAGE);
  });

  it('[NEW] zero rows PLUS a vanished listing is NOT_FOUND, not a status refusal', async () => {
    // A refusal naming the wrong cause is the failure mode this branch exists to avoid —
    // the whole point of distinguishing the concurrency arm is that it is legible.
    flipped = 0;
    const base = listing.findUnique.getMockImplementation();
    listing.findUnique.mockImplementation(async (args: unknown) => {
      const select = (args as { select?: Record<string, unknown> })?.select ?? {};
      // The post-CAS existence probe asks for `id` alone — that is the read that must now
      // answer "gone". The status read above still succeeds, which is the whole point: the
      // row vanished BETWEEN them.
      if (!('status' in select)) return null;
      return base ? base(args) : null;
    });
    await expect(
      setListingVisibilityAsOwner({ appListingId: 'apl_1', visibility: 'testers', userId: 9 })
    ).rejects.toThrow('Listing not found');
  });

  it('[NEW] setting the level it already has is an idempotent no-op, not a write', async () => {
    stored = 'testers';
    await expect(
      setListingVisibilityAsOwner({ appListingId: 'apl_1', visibility: 'testers', userId: 9 })
    ).resolves.toMatchObject({ visibility: 'testers', changed: false });
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('[NEW] an UNSET level is not the same as `private` — setting `private` is a real write', async () => {
    // The column-shape distinction, at the write. A row at NULL asked to become `private`
    // must WRITE (it changes what the store shows for an approved listing), where the
    // idempotence check above would skip it if the two were conflated.
    stored = null;
    await expect(
      setListingVisibilityAsOwner({ appListingId: 'apl_1', visibility: 'private', userId: 9 })
    ).resolves.toMatchObject({ visibility: 'private', changed: true });
    expect(dbMock.dbWrite.$executeRaw).toHaveBeenCalledTimes(1);
  });
});

describe('the manual-apply column gate', () => {
  it('[INV] an UNREADABLE column REFUSES the write rather than dropping it', async () => {
    // 🔴 A SURVIVING MUTANT MADE THIS NEVER REFUSE. Omitting the key instead would report
    // success while the level stayed where it was, and the caller's only recourse would be
    // to try again. The distinct message is what lets a test tell this guard from the
    // validator rejecting an unknown level.
    stored = 'THROW_P2022';
    await expect(
      setListingVisibilityAsOwner({ appListingId: 'apl_1', visibility: 'testers', userId: 9 })
    ).rejects.toThrow(VISIBILITY_UNAVAILABLE_MESSAGE);
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('[INV] it refuses BEFORE any side effect', async () => {
    stored = 'THROW_P2022';
    await setListingVisibilityAsOwner({
      appListingId: 'apl_1',
      visibility: 'testers',
      userId: 9,
    }).catch(() => null);
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });
});

describe('a missing listing', () => {
  it('[INV] NOT_FOUND, and nothing is written', async () => {
    row = null;
    await expect(
      setListingVisibilityAsOwner({ appListingId: 'apl_gone', visibility: 'public', userId: 9 })
    ).rejects.toThrow('Listing not found');
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });
});

/**
 * 🔴 THE MODERATOR PATH — a SEPARATE audience, not a relaxation of the owner gate.
 *
 * The owner path has no mod bypass and this one has no owner gate; they share only
 * `applyVisibility`, which is where D1 and the review ceiling live. The cases below are
 * the behavioural half of four mutants that a structural ledger cannot see:
 *
 *   · dropping the moderation event entirely — a moderator silently changes a stranger's
 *     discoverability with nothing in the owner-readable history;
 *   · writing the event BEFORE the level, so a refused act is logged as if it happened;
 *   · writing an event for an idempotent no-op, filling that history with noise;
 *   · attributing the event to the listing owner instead of the acting moderator.
 */
describe('the MODERATOR path', () => {
  const event = () => dbMock.dbWrite.appListingModerationEvent.create;

  it('[NEW] writes a `set-visibility` event attributed to the MODERATOR, with both levels', async () => {
    stored = 'moderators';
    const res = await setListingVisibilityAsModerator({
      appListingId: 'apl_1',
      visibility: 'public',
      reason: 'owner asked in ticket 123',
      moderatorUserId: 77,
    });
    expect(res).toEqual({ appListingId: 'apl_1', visibility: 'public', changed: true });
    expect(event()).toHaveBeenCalledTimes(1);
    const data = (event() as unknown as { mock: { calls: { 0: { data: Record<string, unknown> } }[] } })
      .mock.calls[0][0].data;
    expect(data.action).toBe('set-visibility');
    // 🔴 THE ACTOR IS THE MODERATOR. A mutant attributing this to the listing's owner
    // produces an audit row that blames the victim, and nothing else would notice.
    expect(data.actorUserId).toBe(77);
    expect(data.reason).toBe('owner asked in ticket 123');
    expect(data.appListingId).toBe('apl_1');
    // 🔴 THE LEVELS, NOT A STATUS. This act changes neither the status nor anything else,
    // so a `status` transition here would describe something that did not happen.
    expect(data.before).toEqual({ visibility: 'moderators' });
    expect(data.after).toEqual({ visibility: 'public' });
  });

  it('[NEW] records an UNSET pre-state as null rather than inventing `private`', async () => {
    // The three-states rule reaching the audit trail: `null` means "no choice expressed",
    // which is NOT the `private` level, and an event claiming otherwise would misreport
    // what the moderator changed.
    stored = null;
    await setListingVisibilityAsModerator({
      appListingId: 'apl_1',
      visibility: 'testers',
      reason: 'promoting to testers',
      moderatorUserId: 77,
    });
    const data = (event() as unknown as { mock: { calls: { 0: { data: Record<string, unknown> } }[] } })
      .mock.calls[0][0].data;
    expect(data.before).toEqual({ visibility: null });
  });

  it('[INV] writes NO event when the level is already the requested one', async () => {
    // Idempotent success. An event row here would fill the owner's visible history with
    // no-ops, and the history is the only place they learn a moderator touched this.
    stored = 'public';
    const res = await setListingVisibilityAsModerator({
      appListingId: 'apl_1',
      visibility: 'public',
      reason: 'no-op',
      moderatorUserId: 77,
    });
    expect(res.changed).toBe(false);
    expect(event()).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('[INV] writes NO event when the write is REFUSED — apply first, record second', async () => {
    // 🔴 THE ORDERING MUTANT. Recording before applying would log moderator acts that were
    // refused, which is worse than not logging at all on a surface whose job is to be
    // believed. Driven through D1 (a `removed` listing refuses a level for a mod too).
    row = { id: 'apl_1', slug: 'an-app', status: 'removed', appBlock: { status: 'approved' } };
    await expect(
      setListingVisibilityAsModerator({
        appListingId: 'apl_1',
        visibility: 'public',
        reason: 'should not land',
        moderatorUserId: 77,
      })
    ).rejects.toThrow(VISIBILITY_STATUS_INELIGIBLE_MESSAGE);
    expect(event()).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('[INV] the REVIEW CEILING binds a moderator too — a draft cannot be made public', async () => {
    // 🔴 D7 APPLIES TO WHOEVER IS ASKING. The ceiling is a property of what has been
    // REVIEWED, not of the caller's role: a moderator who wants a draft public approves it
    // rather than relabelling it. A mutant exempting moderators from the ceiling would
    // serve a listing no moderator had reviewed to the anonymous catalog.
    row = { id: 'apl_1', slug: 'an-app', status: 'draft', appBlock: { status: 'approved' } };
    expect(maxVisibilityForStatus('draft')).toBe('moderators');
    await expect(
      setListingVisibilityAsModerator({
        appListingId: 'apl_1',
        visibility: 'public',
        reason: 'tries to bypass review',
        moderatorUserId: 77,
      })
    ).rejects.toThrow(VISIBILITY_EXCEEDS_REVIEW_CEILING_MESSAGE);
    expect(event()).not.toHaveBeenCalled();
    // The POSITIVE CONTROL for the same status: `moderators` is AT the ceiling and lands,
    // so the refusal above is about the level and not about drafts being unwritable.
    await expect(
      setListingVisibilityAsModerator({
        appListingId: 'apl_1',
        visibility: 'moderators',
        reason: 'within the ceiling',
        moderatorUserId: 77,
      })
    ).resolves.toMatchObject({ changed: true });
    expect(event()).toHaveBeenCalledTimes(1);
  });

  it('[INV] does NOT consult the owner access resolver — the two audiences are separate', async () => {
    // 🔴 THE SHAPE THAT WOULD UNDO THE DESIGN. If this path ever routed through
    // `resolveListingAccess`, a moderator would need a ROLE on the listing to moderate it —
    // and the obvious "fix" for that is a mod bypass inside the owner gate, which is the
    // unaudited write the separate proc exists to prevent. The router's
    // `moderatorProcedure` is the gate here; the service owns the lifecycle rules only.
    mockResolveListingAccess.mockImplementation(async () => null);
    await expect(
      setListingVisibilityAsModerator({
        appListingId: 'apl_1',
        visibility: 'public',
        reason: 'a mod holds no seat on this app',
        moderatorUserId: 77,
      })
    ).resolves.toMatchObject({ changed: true });
    expect(mockResolveListingAccess).not.toHaveBeenCalled();
  });

  it('[NEW] 🔴 the event and the level write go through ONE transaction client', async () => {
    // 🔴 THE REGRESSION TEST FOR A SHIPPED DEFECT, and it is precise about what a MOCK can
    // prove. The revision that shipped did the level write and the event in two separate
    // round trips while its own header claimed a moderator write was "structurally incapable
    // of happening without an event row". It was not: the event insert was rejected by the
    // action CHECK (`set-visibility` was unregistered) AFTER the level had committed, so a
    // stranger's app discoverability changed with no audit row — and the retry then
    // short-circuited `changed: false` and returned 200 over the unrecorded act.
    //
    // ⚠️ A MOCKED `$transaction` CANNOT PROVE ROLLBACK — the shared mock runs the callback
    // and has no transactional semantics, so nothing here demonstrates the level reverting.
    // What IS assertable, and what actually guarantees atomicity in production, is that both
    // statements are issued on the SAME client the transaction handed the callback. That is
    // the structural property; the rollback follows from Postgres.
    stored = 'moderators';
    await setListingVisibilityAsModerator({
      appListingId: 'apl_1',
      visibility: 'public',
      reason: 'audited change',
      moderatorUserId: 77,
    });
    expect(dbMock.dbWrite.$transaction).toHaveBeenCalledTimes(1);
    // The write and the event both ran — and the event's own client is the tx's, not a
    // second top-level call. The shared mock hands the callback `dbWrite` itself, so the
    // observable is that BOTH landed inside the single `$transaction` invocation.
    expect(dbMock.dbWrite.$executeRaw).toHaveBeenCalledTimes(1);
    expect(event()).toHaveBeenCalledTimes(1);
  });

  it('[NEW] 🔴 a REJECTED event propagates — the proc must not report success', async () => {
    // The other half: if the audit row cannot be written the caller has to hear about it.
    // This is the exact shape prod produced (23514 on the action CHECK), modelled as a
    // throwing `create`. Reporting success here is what made the retry dangerous.
    stored = 'moderators';
    (event() as unknown as MockFn).mockImplementation(async () => {
      throw Object.assign(new Error('violates check constraint'), { code: 'P2010' });
    });
    await expect(
      setListingVisibilityAsModerator({
        appListingId: 'apl_1',
        visibility: 'public',
        reason: 'audit row will be rejected',
        moderatorUserId: 77,
      })
    ).rejects.toThrow('violates check constraint');
  });

  it('[INV] 🔴 the action it writes is REGISTERED in the moderation taxonomy', async () => {
    // 🔴 THE DEFECT WAS AN UNREGISTERED LITERAL, so this pins the registration itself rather
    // than the string. `action: 'set-visibility'` shipped as a bare literal with no entry in
    // APP_LISTING_MODERATION_ACTIONS, no classification in the state-changing/neutral
    // partition, and no action-CHECK widen migration — and ALL THREE of this repo's gates
    // for that class fire on REGISTERING an action, so an unregistered one is invisible to
    // every one of them and `pnpm typecheck` was clean. Deriving the constant from the
    // taxonomy is what arms them; this asserts the derivation holds.
    expect(APP_LISTING_MODERATION_ACTIONS).toContain(SET_VISIBILITY_ACTION);
    stored = 'moderators';
    await setListingVisibilityAsModerator({
      appListingId: 'apl_1',
      visibility: 'public',
      reason: 'registered action',
      moderatorUserId: 77,
    });
    const written = (
      event() as unknown as { mock: { calls: { 0: { data: Record<string, unknown> } }[] } }
    ).mock.calls[0][0].data.action;
    expect(written).toBe(SET_VISIBILITY_ACTION);
    // 🔴 The round trip that matters: whatever the create site actually wrote is a MEMBER of
    // the taxonomy. A literal would satisfy the line above and fail this one.
    expect(APP_LISTING_MODERATION_ACTIONS as readonly string[]).toContain(written);
  });

  it('[INV] refuses on an UNAPPLIED migration, and records nothing', async () => {
    // `assertVisibilityWritable` is shared, but the event half is new: a refusal here must
    // not leave an audit row claiming a level the database cannot hold.
    stored = 'THROW_P2022';
    await expect(
      setListingVisibilityAsModerator({
        appListingId: 'apl_1',
        visibility: 'public',
        reason: 'migration pending',
        moderatorUserId: 77,
      })
    ).rejects.toThrow(VISIBILITY_UNAVAILABLE_MESSAGE);
    expect(event()).not.toHaveBeenCalled();
  });
});
