import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * App Listing COLLABORATORS — OWNERSHIP TRANSFER, END TO END, AGAINST ONE MUTABLE STATE.
 *
 * 🔴 THIS SUITE EXISTS BECAUSE EVERY OTHER ONE IS SCOPED TO A SINGLE SURFACE.
 * `app-ownership-transfer.service.test.ts` proves each function in isolation against
 * hand-set fixtures, `app-ownership-transfer.inbox.test.ts` proves the recipient read
 * against its own table, and both are green on a feature nobody can complete — because
 * neither ever builds the state the NEXT step would actually see. That is the isolation
 * seam: two hermetically-tested halves and a defect that lives only in the join.
 *
 * So here the fake DB is STATEFUL. `initiateTransfer` writes a row that
 * `listMyPendingTransfers` then has to find; the id THAT read returns is the one handed
 * to `acceptTransfer`; and the ownership columns `acceptTransfer` writes are the ones
 * `resolveListingAccess` is asked about afterwards. Nothing is re-stubbed between steps —
 * a step that wrote the wrong column, or a read that queried the wrong one, fails here
 * even though both would pass in isolation.
 *
 * The relationship being pinned, in order:
 *   1. the owner offers → NOTHING moves;
 *   2. the RECIPIENT can discover the offer (this is the link that did not exist);
 *   3. while it is open, the recipient still has NO role;
 *   4. the recipient accepts → BOTH ownership columns move in one transaction;
 *   5. the OLD owner loses `owner`, the new owner gains it;
 *   6. the offer leaves the inbox.
 */

const { mockDb, state } = vi.hoisted(() => {
  type Transfer = {
    id: string;
    appListingId: string;
    fromUserId: number;
    toUserId: number;
    status: string;
    expiresAt: Date;
    createdAt: Date;
    respondedAt: Date | null;
  };
  const state = {
    /** `OauthClient.userId` — the CANONICAL owner of an on-site app. */
    clientOwner: 0,
    /** `AppListing.userId` — the denormalized copy. */
    listingOwner: 0,
    kind: 'onsite' as string,
    transfers: [] as Transfer[],
    seats: [] as Array<{ appListingId: string; userId: number; status: string }>,
    events: [] as Array<Record<string, unknown>>,
    bannedAt: null as Date | null,
  };

  const LISTING_ID = 'apl_seam';
  const CLIENT_ID = 'oc_seam';
  const BLOCK_ID = 'ab_seam';

  /** The listing row, ASSEMBLED FROM STATE on every read — never a frozen fixture. */
  const listingRow = () => ({
    id: LISTING_ID,
    slug: 'seam-app',
    name: 'Seam App',
    kind: state.kind,
    userId: state.listingOwner,
    appBlockId: state.kind === 'onsite' ? BLOCK_ID : null,
    connectClientId: null,
    revisionOfId: null,
    revisionOf: null,
    icon: null,
    appBlock:
      state.kind === 'onsite'
        ? { appId: CLIENT_ID, blockId: 'seam-app', app: { userId: state.clientOwner } }
        : null,
  });

  const db = {
    appListing: {
      findUnique: vi.fn(async (args: unknown) => {
        const w = (args as { where: { id?: string } }).where;
        return w.id === LISTING_ID ? listingRow() : null;
      }),
      updateMany: vi.fn(async (args: unknown) => {
        const { where, data } = args as {
          where: { id: string; userId?: number };
          data: { userId: number };
        };
        if (where.id !== LISTING_ID) return { count: 0 };
        if (where.userId !== undefined && where.userId !== state.listingOwner) return { count: 0 };
        state.listingOwner = data.userId;
        return { count: 1 };
      }),
    },
    oauthClient: {
      updateMany: vi.fn(async (args: unknown) => {
        const { where, data } = args as {
          where: { id: string; userId?: number };
          data: { userId: number };
        };
        if (where.id !== CLIENT_ID) return { count: 0 };
        if (where.userId !== undefined && where.userId !== state.clientOwner) return { count: 0 };
        state.clientOwner = data.userId;
        return { count: 1 };
      }),
    },
    user: {
      findUnique: vi.fn(async (args: unknown) => {
        const id = (args as { where: { id: number } }).where.id;
        return { id, bannedAt: state.bannedAt };
      }),
    },
    appCollaborator: {
      findFirst: vi.fn(async (args: unknown) => {
        const w = (args as { where: { appListingId: string; userId: number; status: string } })
          .where;
        return (
          state.seats.find(
            (s) =>
              s.appListingId === w.appListingId && s.userId === w.userId && s.status === w.status
          ) ?? null
        );
      }),
    },
    appOwnershipTransfer: {
      create: vi.fn(async (args: unknown) => {
        const data = (args as { data: Record<string, unknown> }).data;
        const row = { ...data, createdAt: new Date(), respondedAt: null } as Transfer;
        state.transfers.push(row);
        return row;
      }),
      findUnique: vi.fn(async (args: unknown) => {
        const id = (args as { where: { id: string } }).where.id;
        const t = state.transfers.find((r) => r.id === id);
        return t ? { ...t, appListing: listingRow() } : null;
      }),
      findFirst: vi.fn(async (args: unknown) => {
        const w = (args as { where: { appListingId?: string; status?: string } }).where;
        return (
          state.transfers.find(
            (r) =>
              (w.appListingId === undefined || r.appListingId === w.appListingId) &&
              (w.status === undefined || r.status === w.status)
          ) ?? null
        );
      }),
      findMany: vi.fn(async (args: unknown) => {
        const w = (args as { where: { toUserId?: number; status?: string } }).where ?? {};
        return state.transfers
          .filter(
            (r) =>
              (w.toUserId === undefined || r.toUserId === w.toUserId) &&
              (w.status === undefined || r.status === w.status)
          )
          .map((r) => ({ ...r, appListing: listingRow() }));
      }),
      updateMany: vi.fn(async (args: unknown) => {
        const { where, data } = args as {
          where: { id?: string; appListingId?: string; status?: string; expiresAt?: unknown };
          data: Record<string, unknown>;
        };
        let count = 0;
        for (const r of state.transfers) {
          if (where.id !== undefined && r.id !== where.id) continue;
          if (where.appListingId !== undefined && r.appListingId !== where.appListingId) continue;
          if (where.status !== undefined && r.status !== where.status) continue;
          if (where.expiresAt !== undefined) {
            const lte = (where.expiresAt as { lte?: Date }).lte;
            if (lte && r.expiresAt.getTime() > lte.getTime()) continue;
          }
          Object.assign(r, data);
          count += 1;
        }
        return { count };
      }),
    },
    appOwnershipEvent: {
      create: vi.fn(async (args: unknown) => {
        const data = (args as { data: Record<string, unknown> }).data;
        state.events.push(data);
        return data;
      }),
    },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (cb: (tx: typeof db) => Promise<unknown>) => cb(db));

  return { mockDb: db, state, LISTING_ID, CLIENT_ID };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockDb }));
vi.mock('~/server/services/blocks/app-repo-access', () => ({
  grantAppRepoWrite: vi.fn(async () => undefined),
  revokeAppRepoWrite: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/blocks/app-collaborator-notify', () => ({
  notifyAppCollaborator: vi.fn(async () => undefined),
}));

const { acceptTransfer, initiateTransfer, listMyPendingTransfers } = await import(
  '~/server/services/blocks/app-ownership-transfer.service'
);
const { resolveListingAccess } = await import('~/server/services/blocks/app-access.service');

const LISTING = 'apl_seam';
const OLD_OWNER = 10;
const NEW_OWNER = 20;
const BYSTANDER = 30;
const EDITOR = 40;

beforeEach(() => {
  vi.clearAllMocks();
  state.clientOwner = OLD_OWNER;
  state.listingOwner = OLD_OWNER;
  state.kind = 'onsite';
  state.transfers.length = 0;
  state.seats.length = 0;
  state.events.length = 0;
  state.bannedAt = null;
  mockDb.$transaction.mockImplementation(async (cb: (tx: typeof mockDb) => Promise<unknown>) =>
    cb(mockDb)
  );
});

describe('🔴 THE WHOLE HAND-OVER, against one mutable state (ON-SITE)', () => {
  it('offer → the recipient DISCOVERS it → accepts → ownership has moved, and the old owner has lost it', async () => {
    // ── PRECONDITION, measured rather than assumed.
    expect((await resolveListingAccess(LISTING, OLD_OWNER))?.role).toBe('owner');
    expect((await resolveListingAccess(LISTING, NEW_OWNER))?.role).toBeNull();

    // ── 1. THE OWNER OFFERS.
    const offer = await initiateTransfer({
      appListingId: LISTING,
      toUserId: NEW_OWNER,
      actorUserId: OLD_OWNER,
    });
    expect(offer.status).toBe('pending');
    // NOTHING has moved yet — asserted on the STATE, not on a mock call count.
    expect(state.clientOwner).toBe(OLD_OWNER);
    expect(state.listingOwner).toBe(OLD_OWNER);

    // ── 2. THE RECIPIENT DISCOVERS IT. 🔴 This is the link that did not exist: the
    // recipient never saw the listing id, so the id used below comes from the READ, not
    // from the write above.
    const inbox = await listMyPendingTransfers(NEW_OWNER);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].appListingId).toBe(LISTING);
    expect(inbox[0].name).toBe('Seam App');
    expect(inbox[0].fromUserId).toBe(OLD_OWNER);
    const discoveredTransferId = inbox[0].transferId;
    expect(discoveredTransferId).toBe(offer.id);

    // ── 3. A PENDING OFFER CONFERS NOTHING while it sits open.
    expect((await resolveListingAccess(LISTING, NEW_OWNER))?.role).toBeNull();
    expect((await resolveListingAccess(LISTING, OLD_OWNER))?.role).toBe('owner');

    // ── 4. THE RECIPIENT ACCEPTS, using the id the inbox gave them.
    const accepted = await acceptTransfer({
      transferId: discoveredTransferId,
      userId: NEW_OWNER,
    });
    expect(accepted.fromUserId).toBe(OLD_OWNER);
    expect(accepted.toUserId).toBe(NEW_OWNER);

    // BOTH columns moved — the canonical one and the denormalized copy.
    expect(state.clientOwner).toBe(NEW_OWNER);
    expect(state.listingOwner).toBe(NEW_OWNER);

    // ── 5. THE ROLE FLIP, read back through the real resolver.
    expect((await resolveListingAccess(LISTING, NEW_OWNER))?.role).toBe('owner');
    expect((await resolveListingAccess(LISTING, OLD_OWNER))?.role).toBeNull();

    // ── 6. THE OFFER LEAVES THE INBOX.
    expect(await listMyPendingTransfers(NEW_OWNER)).toEqual([]);
    expect(state.transfers[0].status).toBe('accepted');
  });

  /**
   * 🔴 THE OLD OWNER IS NOT DOWNGRADED TO EDITOR — they lose the app entirely. A hand-over
   * that quietly left the previous owner with edit rights would be indistinguishable from
   * a completed transfer at every surface that only asks "can I edit this?".
   */
  it('the old owner is left with NO role at all, not an editor seat', async () => {
    const offer = await initiateTransfer({
      appListingId: LISTING,
      toUserId: NEW_OWNER,
      actorUserId: OLD_OWNER,
    });
    await acceptTransfer({ transferId: offer.id, userId: NEW_OWNER });

    const after = await resolveListingAccess(LISTING, OLD_OWNER);
    expect(after?.role).toBeNull();
    expect(after?.ownerUserId).toBe(NEW_OWNER);
    // POSITIVE CONTROL: the resolver CAN still return `editor` off this same state, so a
    // null above is a real absence rather than a resolver that answers null to everyone.
    state.seats.push({ appListingId: LISTING, userId: EDITOR, status: 'accepted' });
    expect((await resolveListingAccess(LISTING, EDITOR))?.role).toBe('editor');
  });

  /** Seats survive the hand-over — the listing keeps its editors. */
  it('an existing editor keeps their seat across the transfer', async () => {
    state.seats.push({ appListingId: LISTING, userId: EDITOR, status: 'accepted' });
    expect((await resolveListingAccess(LISTING, EDITOR))?.role).toBe('editor');

    const offer = await initiateTransfer({
      appListingId: LISTING,
      toUserId: NEW_OWNER,
      actorUserId: OLD_OWNER,
    });
    await acceptTransfer({ transferId: offer.id, userId: NEW_OWNER });

    expect((await resolveListingAccess(LISTING, EDITOR))?.role).toBe('editor');
  });

  /**
   * 🔴 THE LEAK, ASSERTED ACROSS THE SEAM rather than against a stubbed table: an offer
   * created by the real `initiateTransfer` must not be discoverable by anyone but its
   * addressee.
   */
  it('a bystander’s inbox never sees the offer, at any point in the flow', async () => {
    expect(await listMyPendingTransfers(BYSTANDER)).toEqual([]);
    const offer = await initiateTransfer({
      appListingId: LISTING,
      toUserId: NEW_OWNER,
      actorUserId: OLD_OWNER,
    });
    expect(await listMyPendingTransfers(BYSTANDER)).toEqual([]);
    // POSITIVE CONTROL: the offer really is live and really is discoverable — by its
    // addressee. Without this the two empties above are indistinguishable from a read
    // that always returns nothing.
    expect((await listMyPendingTransfers(NEW_OWNER)).map((r) => r.transferId)).toEqual([offer.id]);
  });

  /**
   * 🔴 THE OFFER IS NOT SELF-SERVE. The owner cannot accept their own offer on the
   * recipient's behalf, and the id being valid does not help them.
   */
  it('the OFFERING owner cannot accept the offer themselves', async () => {
    const offer = await initiateTransfer({
      appListingId: LISTING,
      toUserId: NEW_OWNER,
      actorUserId: OLD_OWNER,
    });
    await expect(acceptTransfer({ transferId: offer.id, userId: OLD_OWNER })).rejects.toMatchObject(
      { code: 'NOT_OWNER' }
    );
    expect(state.clientOwner).toBe(OLD_OWNER);
    expect(state.listingOwner).toBe(OLD_OWNER);
  });

  /**
   * 🔴 A SECOND ACCEPT OF THE SAME OFFER MOVES NOTHING. The status guard on step (4) is
   * what makes the flow idempotent; without a stateful fake this is untestable, because
   * the row's status never changes.
   */
  it('accepting twice is refused the second time, and nothing moves again', async () => {
    const offer = await initiateTransfer({
      appListingId: LISTING,
      toUserId: NEW_OWNER,
      actorUserId: OLD_OWNER,
    });
    await acceptTransfer({ transferId: offer.id, userId: NEW_OWNER });
    expect(state.clientOwner).toBe(NEW_OWNER);

    await expect(acceptTransfer({ transferId: offer.id, userId: NEW_OWNER })).rejects.toMatchObject(
      { code: 'NO_INVITE' }
    );
    expect(state.clientOwner).toBe(NEW_OWNER);
    expect(state.listingOwner).toBe(NEW_OWNER);
  });

  /**
   * 🔴 MONEY INVARIANCE ACROSS THE COMPLETED FLOW. `BlockBuzzAttribution` is not even
   * present on this fake: a service that reached for it would throw rather than silently
   * pass, which is the stronger form of "never touched".
   */
  it('the completed hand-over touches no attribution table', async () => {
    const offer = await initiateTransfer({
      appListingId: LISTING,
      toUserId: NEW_OWNER,
      actorUserId: OLD_OWNER,
    });
    await acceptTransfer({ transferId: offer.id, userId: NEW_OWNER });
    expect(Object.keys(mockDb)).not.toContain('blockBuzzAttribution');
    // The audit trail IS written, so "nothing was recorded" is excluded as the reason.
    expect(state.events.map((e) => e.action)).toEqual(['transfer_initiated', 'transfer_accepted']);
  });
});

describe('🔴 THE WHOLE HAND-OVER (OFF-SITE) — one column, and it is the authority', () => {
  beforeEach(() => {
    state.kind = 'offsite';
  });

  it('offer → discover → accept moves AppListing.userId and leaves the client alone', async () => {
    expect((await resolveListingAccess(LISTING, OLD_OWNER))?.role).toBe('owner');
    const offer = await initiateTransfer({
      appListingId: LISTING,
      toUserId: NEW_OWNER,
      actorUserId: OLD_OWNER,
    });
    const inbox = await listMyPendingTransfers(NEW_OWNER);
    expect(inbox.map((r) => r.kind)).toEqual(['offsite']);
    expect(inbox[0].appBlockId).toBeNull();

    await acceptTransfer({ transferId: offer.id, userId: NEW_OWNER });

    expect(state.listingOwner).toBe(NEW_OWNER);
    // 🔴 The OauthClient was never asked to move — there is none in an off-site
    // listing's ownership chain.
    expect(mockDb.oauthClient.updateMany).not.toHaveBeenCalled();
    expect(state.clientOwner).toBe(OLD_OWNER);
    expect((await resolveListingAccess(LISTING, NEW_OWNER))?.role).toBe('owner');
    expect((await resolveListingAccess(LISTING, OLD_OWNER))?.role).toBeNull();
  });

  /**
   * 🔴 POSITIVE CONTROL for the zero above: on the ON-SITE path this same fake DOES
   * record an `oauthClient.updateMany`, so `not.toHaveBeenCalled()` means the kind
   * branch fired — not that the mock is unreachable.
   */
  it('POSITIVE CONTROL: the same fake DOES see an oauthClient write when the kind is onsite', async () => {
    state.kind = 'onsite';
    const offer = await initiateTransfer({
      appListingId: LISTING,
      toUserId: NEW_OWNER,
      actorUserId: OLD_OWNER,
    });
    await acceptTransfer({ transferId: offer.id, userId: NEW_OWNER });
    expect(mockDb.oauthClient.updateMany).toHaveBeenCalled();
  });
});
