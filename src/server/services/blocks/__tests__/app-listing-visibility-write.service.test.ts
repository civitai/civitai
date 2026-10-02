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
import {
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

function installDefaults() {
  row = { id: 'apl_1', slug: 'an-app', status: 'approved', appBlock: { status: 'approved' } };
  stored = null;
  // 🔴 DISCRIMINATE ON `status`, NOT ON `visibility`. The write path's single row read now
  // names BOTH (it derives the level from the same read rather than paying a third PK
  // lookup), so a mock keyed on `'visibility' in select` answers the STATUS read with a
  // level-only object and every D1 case silently loses its row. That cost a round of red
  // tests whose message pointed at the wrong gate.
  listing.findUnique.mockImplementation(async (args: unknown) => {
    const select = (args as { select?: Record<string, unknown> })?.select ?? {};
    if ('status' in select) {
      // The combined read. P2022 here is what an unapplied migration produces, and the
      // service re-reads without the column — mirror that by answering the narrow select.
      if (stored === 'THROW_P2022' && 'visibility' in select) {
        throw Object.assign(new Error('column does not exist'), { code: 'P2022' });
      }
      return row ? { ...row, visibility: stored === 'THROW_P2022' ? null : stored } : null;
    }
    // The post-CAS existence probe asks for `id` alone.
    return row ? { id: 'apl_1' } : null;
  });
  listing.updateMany.mockImplementation(async () => ({ count: 1 }));
  // 🔴 THE TRANSACTION RUNS ITS CALLBACK. A `$transaction` fake that resolves without
  // invoking the callback would make every write assertion below vacuous while every test
  // stayed green — the write simply would not happen.
  (
    dbMock.dbWrite.$transaction as unknown as { mockImplementation: (f: unknown) => void }
  ).mockImplementation(async (fn: unknown) =>
    typeof fn === 'function' ? (fn as (tx: unknown) => unknown)(dbMock.dbWrite) : undefined
  );
  mockResolveListingAccess.mockImplementation(async () => ({ role: 'owner' }));
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
    expect(listing.updateMany).not.toHaveBeenCalled();
  });

  it('[INV] a row that resolves with a NULL role is refused', async () => {
    // The other shape `resolveListingAccess` can return: a row exists but the caller holds
    // no accepted seat on it. `{ role: null }` must be refused exactly like `null`.
    mockResolveListingAccess.mockImplementation(async () => ({ role: null }));
    await expect(
      setListingVisibilityAsOwner({ appListingId: 'apl_1', visibility: 'testers', userId: 9 })
    ).rejects.toThrow(VISIBILITY_NOT_OWNED_MESSAGE);
    expect(listing.updateMany).not.toHaveBeenCalled();
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
    mockResolveListingAccess.mockImplementation(async () => ({ role: 'editor' }));
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
    // 🔴 A SURVIVING MUTANT. An owner editing their own listing is an ordinary authored
    // edit; attributing a moderation event to them would put owner actions into the
    // moderator audit trail and corrupt the `set-visibility` population.
    await setListingVisibilityAsOwner({ appListingId: 'apl_1', visibility: 'testers', userId: 9 });
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
      expect(listing.updateMany).not.toHaveBeenCalled();
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
    expect(listing.updateMany).not.toHaveBeenCalled();
  });

  it('[INV] a SUSPENDED backing block is refused even when the listing status is fine', async () => {
    // 🔴 THE SECOND HALF OF D1, also a surviving mutant. "Levels apply to non-suspended
    // listings only" is a claim about the APP, not only about the listing row — and a block
    // can be suspended through a path that leaves the row's status alone.
    row = { id: 'apl_1', slug: 'an-app', status: 'approved', appBlock: { status: 'suspended' } };
    await expect(
      setListingVisibilityAsOwner({ appListingId: 'apl_1', visibility: 'public', userId: 9 })
    ).rejects.toThrow(VISIBILITY_BLOCK_SUSPENDED_MESSAGE);
    expect(listing.updateMany).not.toHaveBeenCalled();
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
      expect(listing.updateMany).not.toHaveBeenCalled();
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
    const args = listing.updateMany.mock.calls.at(-1)?.[0] as {
      where?: { status?: { in?: string[] } };
      data?: Record<string, unknown>;
    };
    expect(args?.where?.status?.in).toEqual(['draft', 'pending', 'approved']);
    expect(args?.data).toEqual({ visibility: 'testers' });
  });

  it('[INV] zero matched rows is a REFUSAL, never a reported success', async () => {
    // The losing side of the race must be loud. Collapsing this into success would report
    // a level change on a listing that was taken down a millisecond earlier.
    listing.updateMany.mockImplementation(async () => ({ count: 0 }));
    await expect(
      setListingVisibilityAsOwner({ appListingId: 'apl_1', visibility: 'testers', userId: 9 })
    ).rejects.toThrow(VISIBILITY_STATUS_INELIGIBLE_MESSAGE);
  });

  it('[NEW] zero rows PLUS a vanished listing is NOT_FOUND, not a status refusal', async () => {
    // A refusal naming the wrong cause is the failure mode this branch exists to avoid —
    // the whole point of distinguishing the concurrency arm is that it is legible.
    listing.updateMany.mockImplementation(async () => ({ count: 0 }));
    const base = listing.findUnique.getMockImplementation();
    listing.findUnique.mockImplementation(async (args: unknown) => {
      const select = (args as { select?: Record<string, unknown> })?.select ?? {};
      // The post-CAS existence probe asks for `id` alone — that is the read that must now
      // answer "gone". The combined status read above still succeeds, which is the whole
      // point: the row vanished BETWEEN them.
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
    expect(listing.updateMany).not.toHaveBeenCalled();
  });

  it('[NEW] an UNSET level is not the same as `private` — setting `private` is a real write', async () => {
    // The column-shape distinction, at the write. A row at NULL asked to become `private`
    // must WRITE (it changes what the store shows for an approved listing), where the
    // idempotence check above would skip it if the two were conflated.
    stored = null;
    await expect(
      setListingVisibilityAsOwner({ appListingId: 'apl_1', visibility: 'private', userId: 9 })
    ).resolves.toMatchObject({ visibility: 'private', changed: true });
    expect(listing.updateMany).toHaveBeenCalledTimes(1);
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
    expect(listing.updateMany).not.toHaveBeenCalled();
  });

  it('[INV] it refuses BEFORE any side effect', async () => {
    stored = 'THROW_P2022';
    await setListingVisibilityAsOwner({
      appListingId: 'apl_1',
      visibility: 'testers',
      userId: 9,
    }).catch(() => null);
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
  });
});

describe('a missing listing', () => {
  it('[INV] NOT_FOUND, and nothing is written', async () => {
    row = null;
    await expect(
      setListingVisibilityAsOwner({ appListingId: 'apl_gone', visibility: 'public', userId: 9 })
    ).rejects.toThrow('Listing not found');
    expect(listing.updateMany).not.toHaveBeenCalled();
  });
});
