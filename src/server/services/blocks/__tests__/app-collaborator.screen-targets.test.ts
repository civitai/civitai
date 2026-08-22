import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * SCREENING THE INVITE PICKER'S CANDIDATES.
 *
 * The picker's candidate list comes out of user search, which serves cached documents. This is
 * the call that lets the picker stop offering accounts the invite would refuse, WITHOUT asking
 * the search index anything — which is the whole point, since the search index is the thing
 * that can be wrong.
 */

vi.mock('~/server/services/blocks/app-repo-access', () => ({
  grantAppRepoWrite: vi.fn(async () => undefined),
  revokeAppRepoWrite: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/blocks/app-collaborator-notify', () => ({
  notifyAppCollaborator: vi.fn(async () => undefined),
}));

const { getIneligibleCollaboratorTargets, AppCollaboratorError } = await import(
  '~/server/services/blocks/app-collaborator.service'
);

/** Ids chosen pairwise-distinct, and distinct from every count this file asserts. */
const FINE = 4101;
const BANNED = 4102;
const SOFT_DELETED = 4103;
const MISSING = 4104;
const ALSO_FINE = 4105;

const OWNER = 4200;
const STRANGER = 4201;
const LISTING = 'apl_screen';

const BAN_DATE = new Date('2026-03-04T05:06:07.000Z');
const DELETE_DATE = new Date('2026-05-06T07:08:09.000Z');

/** `getIneligibleCollaboratorTargets` reads accounts off the REPLICA. */
const findMany = dbMock.dbRead.user.findMany;
const listingFindUnique = dbMock.dbRead.appListing.findUnique;

const screen = (userIds: number[], actorUserId = OWNER) =>
  getIneligibleCollaboratorTargets({ appListingId: LISTING, actorUserId, userIds });

beforeEach(() => {
  vi.clearAllMocks();
  listingFindUnique.mockResolvedValue({
    id: LISTING,
    slug: 'a-listing',
    kind: 'onsite',
    userId: OWNER,
    appBlockId: null,
    revisionOfId: null,
    appBlock: null,
  });
  findMany.mockImplementation(async (args: any) => {
    const asked: number[] = args?.where?.id?.in ?? [];
    const rows = [
      { id: FINE, bannedAt: null, deletedAt: null },
      { id: ALSO_FINE, bannedAt: null, deletedAt: null },
      { id: BANNED, bannedAt: BAN_DATE, deletedAt: null },
      { id: SOFT_DELETED, bannedAt: null, deletedAt: DELETE_DATE },
    ];
    return rows.filter((r) => asked.includes(r.id));
  });
});

describe('getIneligibleCollaboratorTargets', () => {
  /**
   * The pair. The `not.toContain` half alone is walked by a mutant that returns `[]` for
   * everything; the `toContain` half is what makes that mutant die.
   */
  it('names the banned account and does NOT name the accounts that are fine', async () => {
    const result = await screen([FINE, BANNED, ALSO_FINE]);

    expect(result).toContain(BANNED);
    expect(result).not.toContain(FINE);
    expect(result).not.toContain(ALSO_FINE);
    expect(result).toHaveLength(1);
  });

  it('names a soft-deleted account too', async () => {
    await expect(screen([FINE, SOFT_DELETED])).resolves.toEqual([SOFT_DELETED]);
  });

  /**
   * FAILS CLOSED on an id with no row. A search document can outlive the account it describes,
   * and "we found nothing, so it must be fine" is precisely the wrong reading of that.
   */
  it('names an id that has no account row at all', async () => {
    await expect(screen([FINE, MISSING])).resolves.toEqual([MISSING]);
  });

  it('returns nothing when every candidate is fine', async () => {
    await expect(screen([FINE, ALSO_FINE])).resolves.toEqual([]);
  });

  it('does not query at all for an empty candidate list', async () => {
    await expect(screen([])).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('asks about each id once even when the picker repeats one', async () => {
    await screen([FINE, FINE, BANNED, BANNED]);
    const asked = (findMany.mock.calls[0]?.[0] as any)?.where?.id?.in;
    expect(asked).toEqual([FINE, BANNED]);
  });

  /**
   * It must not read a ban state out of anything cached. The only table it may consult for that
   * is the account table itself — this pins that the read happens, and against `user`.
   */
  it('reads the account rows themselves', async () => {
    await screen([BANNED]);
    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0]?.[0] as any;
    expect(args.select).toMatchObject({ bannedAt: true, deletedAt: true });
  });

  describe('it is keyed to a listing the caller owns', () => {
    /**
     * 🔴 The refusal, and the ORDER of it: ownership is asserted BEFORE any account is read, so
     * a non-owner cannot learn anything about the ids they asked about — not even by timing.
     */
    it('refuses a caller who does not own the listing, without reading any account', async () => {
      await expect(screen([FINE, BANNED], STRANGER)).rejects.toBeInstanceOf(AppCollaboratorError);
      expect(findMany).not.toHaveBeenCalled();
    });

    it('refuses when the listing does not exist', async () => {
      listingFindUnique.mockResolvedValue(null);
      await expect(screen([FINE])).rejects.toBeInstanceOf(AppCollaboratorError);
      expect(findMany).not.toHaveBeenCalled();
    });

    /**
     * The presence half of both refusals above: without it, a mutant that throws for EVERY
     * caller passes them while making the picker permanently unscreened.
     */
    it('…and the owner still gets an answer', async () => {
      await expect(screen([FINE, BANNED])).resolves.toEqual([BANNED]);
      expect(findMany).toHaveBeenCalledTimes(1);
    });
  });
});
