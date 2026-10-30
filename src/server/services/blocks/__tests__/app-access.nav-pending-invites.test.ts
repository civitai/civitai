import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 🔴 THE "INVITES" SUB-NAV TAB MUST SEE **BOTH** KINDS OF PENDING ITEM.
 *
 * `/apps/invites` is where a pending SEAT INVITE and an inbound OWNERSHIP-TRANSFER OFFER
 * both render. The tab that routes there is gated on `getNavSummary`'s
 * `hasPendingInvites`, which is computed by `resolveAppsNavAccess` — and that predicate
 * knew about seat invites ONLY. So a user who had been offered an app and held no seat
 * invite got no tab at all: the offer existed, the page rendered it, and nothing in the
 * chrome ever pointed at the page.
 *
 * This suite pins the widened predicate, its boundary, and the two ways widening it could
 * go wrong.
 *
 * ## 🔴 THE CASE A NAIVE FIX GETS WRONG: expiry is a READ-TIME PREDICATE
 *
 * `AppOwnershipTransfer.expiresAt` is enforced at read time with NO sweeper behind it —
 * `schema.full.prisma` says so on the column, the step-B migration repeats it, and
 * `app-ownership-transfer.service::isLive` is where the accept path applies it. A dead
 * offer therefore keeps `status = 'pending'` FOREVER. A predicate written as
 * `status: 'pending'` alone would latch the tab on permanently for anyone who was ever
 * offered an app, and it would look completely correct in every test that did not
 * deliberately age a row. Both sides of the boundary are asserted below, with STRICT `>`
 * matching `isLive` exactly so the tab and the page cannot disagree about the instant.
 *
 * ## The other two ways this goes wrong
 *
 *   - THE LEAK DIRECTION: keying on the wrong end of the transfer. `toUserId` is the
 *     ADDRESSEE. Keying on `fromUserId` (or on neither) would light the tab for the person
 *     who SENT an offer, or for a bystander.
 *   - CAPABILITY CREEP: a pending offer confers ZERO capability until accepted (the same
 *     consent principle as an unaccepted seat), so it must light "Invites" and must NOT
 *     light "My apps". Asserted explicitly, because the cheapest possible implementation —
 *     OR-ing the new probe into both booleans — would pass every "the tab appears" case.
 */

const { db, store } = vi.hoisted(() => {
  const store = {
    /** Rows of `app_collaborators` for the probed user. */
    seats: [] as Array<{ appListingId: string; userId: number; status: string }>,
    /** Rows of `app_ownership_transfers`. */
    transfers: [] as Array<{
      id: string;
      toUserId: number;
      fromUserId: number;
      status: string;
      expiresAt: Date;
    }>,
    /** Listings the ownership predicate should match, keyed by owner. */
    ownedBy: new Set<number>(),
    /** Force a thrown error out of a named table's probe (the degrade tests). */
    throwOn: null as null | { table: 'appCollaborator' | 'appOwnershipTransfer'; err: unknown },
  };

  const db = {
    appListing: {
      findFirst: vi.fn(async (...a: unknown[]) => {
        const args = (a[0] ?? {}) as { where?: { OR?: Array<Record<string, unknown>> } };
        // Only the ownership question matters here; read the caller off any branch that
        // carries a userId, which every branch of `canonicalOwnerWhereBranches` does.
        for (const branch of args.where?.OR ?? []) {
          const viaBlock = (branch.appBlock as { app?: { userId?: number } } | undefined)?.app
            ?.userId;
          const uid = viaBlock ?? (branch.userId as number | undefined);
          if (typeof uid === 'number' && store.ownedBy.has(uid)) return { id: 'apl_owned' };
        }
        return null;
      }),
    },
    appCollaborator: {
      findFirst: vi.fn(async (...a: unknown[]) => {
        if (store.throwOn?.table === 'appCollaborator') throw store.throwOn.err;
        const w = (a[0] as { where: { userId: number; status: string } }).where;
        return store.seats.find((s) => s.userId === w.userId && s.status === w.status) ?? null;
      }),
    },
    appOwnershipTransfer: {
      findFirst: vi.fn(async (...a: unknown[]) => {
        if (store.throwOn?.table === 'appOwnershipTransfer') throw store.throwOn.err;
        const w = (
          a[0] as {
            where: {
              toUserId?: number;
              fromUserId?: number;
              status?: string;
              expiresAt?: { gt?: Date };
            };
          }
        ).where;
        // 🔴 EVERY CLAUSE THE IMPLEMENTATION SENDS IS APPLIED, and only the clauses it
        // sends. Written from the spec rather than copied from the query, so dropping a
        // clause changes this fake's answer instead of being invisible to it.
        const hit = store.transfers.find(
          (t) =>
            (w.toUserId == null || t.toUserId === w.toUserId) &&
            (w.fromUserId == null || t.fromUserId === w.fromUserId) &&
            (w.status == null || t.status === w.status) &&
            (w.expiresAt?.gt == null || t.expiresAt.getTime() > w.expiresAt.gt.getTime())
        );
        return hit ? { id: hit.id } : null;
      }),
    },
  };
  return { db, store };
});

vi.mock('~/server/db/client', () => ({ dbRead: db, dbWrite: db }));

const { resolveAppsNavAccess } = await import('~/server/services/blocks/app-access.service');

const ME = 501;
const SOMEONE_ELSE = 502;
const NOW = new Date('2026-08-14T12:00:00.000Z');
const IN_AN_HOUR = new Date(NOW.getTime() + 3_600_000);
const AN_HOUR_AGO = new Date(NOW.getTime() - 3_600_000);

function seatInvite(userId = ME, status = 'pending') {
  store.seats.push({ appListingId: 'apl_seat', userId, status });
}

function transferOffer(
  over: Partial<{ toUserId: number; fromUserId: number; status: string; expiresAt: Date }> = {}
) {
  store.transfers.push({
    id: `aot_${store.transfers.length + 1}`,
    toUserId: ME,
    fromUserId: SOMEONE_ELSE,
    status: 'pending',
    expiresAt: IN_AN_HOUR,
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  store.seats.length = 0;
  store.transfers.length = 0;
  store.ownedBy.clear();
  store.throwOn = null;
});

// ---------------------------------------------------------------------------

describe('🔴 POSITIVE CONTROLS: the fake honours its where-clauses', () => {
  it('the transfer probe can MATCH and can MISS on every clause it filters', async () => {
    // Without this, every "no tab" assertion below is indistinguishable from a fake that
    // returns null unconditionally, and every "tab" assertion from one that returns a row
    // unconditionally. Both directions, one clause at a time.
    transferOffer();
    const probe = (where: Record<string, unknown>) => db.appOwnershipTransfer.findFirst({ where });
    expect(await probe({ toUserId: ME, status: 'pending', expiresAt: { gt: NOW } })).not.toBeNull();
    expect(await probe({ toUserId: SOMEONE_ELSE, status: 'pending' })).toBeNull();
    expect(await probe({ toUserId: ME, status: 'accepted' })).toBeNull();
    expect(await probe({ toUserId: ME, expiresAt: { gt: IN_AN_HOUR } })).toBeNull();
    // …and an unfiltered probe still finds it, so the misses above are the CLAUSES'
    // doing and not a fact about the row.
    expect(await probe({})).not.toBeNull();
  });

  it('the seat probe can MATCH and can MISS', async () => {
    seatInvite(ME, 'pending');
    expect(
      await db.appCollaborator.findFirst({ where: { userId: ME, status: 'pending' } })
    ).not.toBeNull();
    expect(
      await db.appCollaborator.findFirst({ where: { userId: ME, status: 'accepted' } })
    ).toBeNull();
    expect(
      await db.appCollaborator.findFirst({ where: { userId: SOMEONE_ELSE, status: 'pending' } })
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('hasPendingInvites — the four-quadrant table', () => {
  it('🔴 a pending TRANSFER OFFER alone lights the tab (the gap this closes)', async () => {
    // The regression case. Before the widening this was `false`, so the only page that
    // renders the offer had no route pointing at it.
    transferOffer();
    expect((await resolveAppsNavAccess(ME, NOW)).hasPendingInvites).toBe(true);
  });

  it('a pending SEAT INVITE alone still lights the tab (INVARIANT GUARD — unchanged)', async () => {
    // 🔴 Labelled honestly: this passes before AND after the widening. It is here to keep
    // the widening from REPLACING the seat arm rather than adding to it — it is not
    // regression coverage for this change.
    seatInvite();
    expect((await resolveAppsNavAccess(ME, NOW)).hasPendingInvites).toBe(true);
  });

  it('BOTH kinds at once lights the tab (INVARIANT GUARD — unchanged)', async () => {
    seatInvite();
    transferOffer();
    expect((await resolveAppsNavAccess(ME, NOW)).hasPendingInvites).toBe(true);
  });

  it('NEITHER kind ⇒ no tab', async () => {
    // The "deny" half. Without it, "always true" satisfies all three cases above.
    expect((await resolveAppsNavAccess(ME, NOW)).hasPendingInvites).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('🔴 EXPIRY is a read-time predicate — a dead offer must not latch the tab on', () => {
  it('an EXPIRED transfer alone ⇒ NO tab', async () => {
    // `status` stays 'pending' forever (no sweeper), so this row is exactly what a naive
    // `status: 'pending'` predicate would light the tab on, permanently.
    transferOffer({ expiresAt: AN_HOUR_AGO });
    expect((await resolveAppsNavAccess(ME, NOW)).hasPendingInvites).toBe(false);
  });

  it('the boundary is STRICT — AT `expiresAt` is already dead, 1ms before is alive', async () => {
    // Matches `app-ownership-transfer.service::isLive`'s `>` exactly. A `>=` here would
    // make the tab outlive the offer by an instant; more importantly, a mismatch is how
    // the tab and the page start disagreeing.
    store.transfers.length = 0;
    transferOffer({ expiresAt: NOW });
    expect((await resolveAppsNavAccess(ME, NOW)).hasPendingInvites).toBe(false);

    store.transfers.length = 0;
    transferOffer({ expiresAt: new Date(NOW.getTime() + 1) });
    expect((await resolveAppsNavAccess(ME, NOW)).hasPendingInvites).toBe(true);
  });

  it('an expired transfer does not suppress a live SEAT invite', async () => {
    // The other direction of the same clause: widening must not let a dead transfer
    // shadow the arm that already worked.
    seatInvite();
    transferOffer({ expiresAt: AN_HOUR_AGO });
    expect((await resolveAppsNavAccess(ME, NOW)).hasPendingInvites).toBe(true);
  });

  it('the DEFAULT `now` is wall-clock — a far-future offer lights the tab with no injection', async () => {
    // 🔴 Proves the injected `now` is a testing affordance and not the only wired path: a
    // default-argument bug (e.g. `now = new Date(0)`) would make every real offer look
    // alive forever, and every test above passes it explicitly.
    transferOffer({ expiresAt: new Date(Date.now() + 86_400_000) });
    expect((await resolveAppsNavAccess(ME)).hasPendingInvites).toBe(true);

    store.transfers.length = 0;
    transferOffer({ expiresAt: new Date(Date.now() - 86_400_000) });
    expect((await resolveAppsNavAccess(ME)).hasPendingInvites).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('🔴 THE LEAK DIRECTION: only the ADDRESSEE is notified', () => {
  it('a transfer addressed to SOMEONE ELSE does not light my tab', async () => {
    transferOffer({ toUserId: SOMEONE_ELSE, fromUserId: 999 });
    expect((await resolveAppsNavAccess(ME, NOW)).hasPendingInvites).toBe(false);
    // …and the control: the same row DOES light the addressee's tab, so the miss above is
    // the `toUserId` clause and not an inert probe.
    expect((await resolveAppsNavAccess(SOMEONE_ELSE, NOW)).hasPendingInvites).toBe(true);
  });

  it('an offer I SENT does not light my own tab', async () => {
    // Keying on `fromUserId` instead of `toUserId` is the one-token version of this bug.
    transferOffer({ fromUserId: ME, toUserId: SOMEONE_ELSE });
    expect((await resolveAppsNavAccess(ME, NOW)).hasPendingInvites).toBe(false);
  });

  it('every TERMINAL status is ignored', async () => {
    // The CHECK constraint's full domain minus 'pending'. A predicate that dropped the
    // status clause would light the tab on a transfer the caller already rejected.
    for (const status of ['accepted', 'rejected', 'cancelled', 'expired']) {
      store.transfers.length = 0;
      transferOffer({ status });
      expect(
        (await resolveAppsNavAccess(ME, NOW)).hasPendingInvites,
        `status=${status} must not light the tab`
      ).toBe(false);
    }
    // Positive control on the loop itself: the same fixture with 'pending' DOES light it,
    // so the four falses are the status clause and not a broken loop body.
    store.transfers.length = 0;
    transferOffer({ status: 'pending' });
    expect((await resolveAppsNavAccess(ME, NOW)).hasPendingInvites).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('🔴 A PENDING OFFER CONFERS ZERO CAPABILITY — it must not light "My apps"', () => {
  it('a live transfer offer leaves hasEditableApps FALSE', async () => {
    // The cheapest wrong implementation — OR the new probe into both booleans — passes
    // every "the tab appears" case above and fails only here.
    transferOffer();
    const nav = await resolveAppsNavAccess(ME, NOW);
    expect(nav.hasPendingInvites).toBe(true);
    expect(nav.hasEditableApps).toBe(false);
  });

  it('POSITIVE CONTROL: hasEditableApps still answers TRUE for a real owner', async () => {
    // Without this, "hasEditableApps is false" is indistinguishable from an ownership
    // probe this suite's fake never satisfies.
    store.ownedBy.add(ME);
    expect((await resolveAppsNavAccess(ME, NOW)).hasEditableApps).toBe(true);
  });

  it('…and TRUE for an ACCEPTED seat holder, with no transfer anywhere', async () => {
    seatInvite(ME, 'accepted');
    const nav = await resolveAppsNavAccess(ME, NOW);
    expect(nav.hasEditableApps).toBe(true);
    expect(nav.hasPendingInvites).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('🔴 the transfer probe DEGRADES with its manual-apply table', () => {
  /**
   * `app_ownership_transfers` is created by the SAME manual-apply migration as
   * `app_collaborators` (`20260811170000_rekey_app_collaborators_step_b_…`), whose own
   * rollback note promises that dropping those tables returns the deployed code to the
   * 42P01 path — "inert-and-owner-only, NOT broken". An unwrapped read here would break
   * that promise by 500-ing every `/apps` page's chrome for the whole deploy window.
   */
  it('a MISSING TABLE (42P01) degrades to false instead of throwing', async () => {
    store.throwOn = {
      table: 'appOwnershipTransfer',
      err: Object.assign(new Error('relation "app_ownership_transfers" does not exist'), {
        code: '42P01',
      }),
    };
    seatInvite();
    const nav = await resolveAppsNavAccess(ME, NOW);
    // The seat arm still answers — the degrade is scoped to the probe that failed.
    expect(nav.hasPendingInvites).toBe(true);
    expect(nav.hasEditableApps).toBe(false);
  });

  it('…and with no seat invite either, it is simply false', async () => {
    store.throwOn = {
      table: 'appOwnershipTransfer',
      err: Object.assign(new Error('relation "app_ownership_transfers" does not exist'), {
        code: '42P01',
      }),
    };
    expect((await resolveAppsNavAccess(ME, NOW)).hasPendingInvites).toBe(false);
  });

  it('🔴 a COLUMN error (42703) still PROPAGATES — a half-applied schema must surface', async () => {
    // The narrowness is the point: swallowing this would turn a genuinely broken schema
    // into a permanent silent "no invites".
    store.throwOn = {
      table: 'appOwnershipTransfer',
      err: Object.assign(new Error('column "expires_at" does not exist'), { code: '42703' }),
    };
    await expect(resolveAppsNavAccess(ME, NOW)).rejects.toThrow(/column "expires_at"/);
  });
});

// ---------------------------------------------------------------------------

describe('🔴 STRUCTURAL: the probe is narrowed on the INDEXED pair', () => {
  it('the query sends toUserId + status + a strict expiresAt bound, and selects one column', async () => {
    // A behavioural assertion cannot tell "narrowed on (to_user_id, status)" from "scanned
    // the table and filtered in JS". `app_ownership_transfers_to_status_idx` is the index
    // this pair exists to hit.
    await resolveAppsNavAccess(ME, NOW);
    expect(db.appOwnershipTransfer.findFirst).toHaveBeenCalledTimes(1);
    const args = db.appOwnershipTransfer.findFirst.mock.calls[0][0] as {
      where: { toUserId: number; status: string; expiresAt: { gt: Date } };
      select: Record<string, boolean>;
    };
    expect(args.where.toUserId).toBe(ME);
    expect(args.where.status).toBe('pending');
    expect(args.where.expiresAt.gt).toBe(NOW);
    expect(args.select).toEqual({ id: true });
    // …and it is an EXISTENCE probe: no `findMany`, no ordering, no rows hydrated.
    expect(Object.keys(db.appOwnershipTransfer)).toEqual(['findFirst']);
  });

  it('all four probes are issued (the nav summary did not silently drop one)', async () => {
    await resolveAppsNavAccess(ME, NOW);
    expect(db.appListing.findFirst).toHaveBeenCalledTimes(1);
    expect(db.appCollaborator.findFirst).toHaveBeenCalledTimes(2);
    expect(db.appOwnershipTransfer.findFirst).toHaveBeenCalledTimes(1);
  });
});
