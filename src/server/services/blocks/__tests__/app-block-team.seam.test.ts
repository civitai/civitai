import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { getOwnedAppBlocks } from '~/server/services/blocks/app-analytics.service';
import {
  _internalsForTests,
  getApprovedAppBlockAnalytics,
  isAppTeamMember,
} from '~/server/services/blocks/known-app-blocks.service';

/**
 * SEAM: the people who may open an app's analytics panel (`getOwnedAppBlocks`, through
 * `resolveAccessibleAppBlockIds`) and the people whose events the custom-events ingest marks as
 * the app's team (`isAppTeamMember`, through `listApprovedAppBlockSeatHolders`) must be the same
 * set. The panel's "Include team activity" toggle hides team rows, so if the two drifted, someone
 * who can see the panel would have their own testing counted, or someone outside the team would
 * be hidden.
 *
 * Both reads run against ONE in-memory database that evaluates the `where` clauses they send, so
 * neither side can pass by being handed rows that already match. The expected team is also
 * written out literally, so the two sides cannot agree on a wrong answer.
 */

type Row = Record<string, unknown>;

const USERS = {
  owner: 100,
  otherOwner: 200,
  offsiteOwner: 300,
  accepted: 1,
  pending: 2,
  declined: 3,
  acceptedOnOther: 4,
  acceptedOnOffsite: 5,
  acceptedOnBlocklessListing: 6,
  stranger: 999,
} as const;

const blocks: Row[] = [
  { id: 'apb_team', status: 'approved', manifest: null, app: { userId: USERS.owner } },
  { id: 'apb_other', status: 'approved', manifest: null, app: { userId: USERS.otherOwner } },
  // An OFF-SITE listing that still has a block: seats on it reach neither the panel nor the team.
  { id: 'apb_offsite', status: 'approved', manifest: null, app: { userId: USERS.offsiteOwner } },
];
const blockById = new Map(blocks.map((b) => [b.id as string, b]));

const listings: Row[] = [
  { id: 'lst_team', kind: 'onsite', appBlockId: 'apb_team' },
  { id: 'lst_other', kind: 'onsite', appBlockId: 'apb_other' },
  { id: 'lst_offsite', kind: 'offsite', appBlockId: 'apb_offsite' },
  { id: 'lst_blockless', kind: 'offsite', appBlockId: null },
].map((l) => ({ ...l, appBlock: l.appBlockId ? blockById.get(l.appBlockId) ?? null : null }));
const listingById = new Map(listings.map((l) => [l.id as string, l]));

const seats: Row[] = [
  { appListingId: 'lst_team', userId: USERS.accepted, status: 'accepted' },
  { appListingId: 'lst_team', userId: USERS.pending, status: 'pending' },
  { appListingId: 'lst_team', userId: USERS.declined, status: 'rejected' },
  { appListingId: 'lst_other', userId: USERS.pending, status: 'accepted' },
  { appListingId: 'lst_other', userId: USERS.acceptedOnOther, status: 'accepted' },
  { appListingId: 'lst_offsite', userId: USERS.acceptedOnOffsite, status: 'accepted' },
  { appListingId: 'lst_blockless', userId: USERS.acceptedOnBlocklessListing, status: 'accepted' },
].map((s) => ({ ...s, appListing: listingById.get(s.appListingId as string) }));

/**
 * The subset of Prisma's `where` these reads use: equality, `{ not }`, `{ in }`, and a nested
 * object for a relation (an absent related row matches nothing). Anything else throws, so a read
 * that starts using another operator fails here instead of being silently treated as a match.
 */
function matches(row: Row | null | undefined, where: Row | undefined): boolean {
  if (!where) return true;
  if (!row) return false;
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key];
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
      const c = cond as Row;
      if ('not' in c) return value !== c.not;
      if ('in' in c) return (c.in as unknown[]).includes(value);
      // Otherwise a relation filter, which needs a related row (or null) on that key.
      if (value !== null && typeof value !== 'object') {
        throw new Error(`unsupported filter on ${key}: ${JSON.stringify(c)}`);
      }
      return matches(value as Row | null, c);
    }
    if (key === 'OR' || key === 'AND' || key === 'NOT') throw new Error(`unsupported ${key}`);
    return value === cond;
  });
}

function table(rows: Row[]) {
  return async (args?: { where?: Row }) => rows.filter((r) => matches(r, args?.where));
}

beforeEach(() => {
  vi.clearAllMocks();
  _internalsForTests.reset();
  dbMock.dbRead.appBlock.findMany.mockImplementation(table(blocks));
  dbMock.dbRead.appListing.findMany.mockImplementation(table(listings));
  dbMock.dbRead.appCollaborator.findMany.mockImplementation(table(seats));
});

async function panelCanSee(userId: number, appBlockId: string): Promise<boolean> {
  return (await getOwnedAppBlocks({ ownerUserId: userId, appBlockId })).length > 0;
}

async function ingestTeam(userId: number, appBlockId: string): Promise<boolean> {
  const analytics = await getApprovedAppBlockAnalytics(appBlockId);
  if (!analytics) throw new Error(`${appBlockId} is not approved in the fixture`);
  return isAppTeamMember(analytics, userId);
}

const EXPECTED_TEAM: Record<string, number[]> = {
  apb_team: [USERS.owner, USERS.accepted],
  apb_other: [USERS.otherOwner, USERS.pending, USERS.acceptedOnOther],
  apb_offsite: [USERS.offsiteOwner],
};

describe('seam: who may see the analytics panel = whose events count as team', () => {
  for (const appBlockId of Object.keys(EXPECTED_TEAM)) {
    it(`${appBlockId}: both sides name exactly the expected team`, async () => {
      const panel: number[] = [];
      const team: number[] = [];
      for (const userId of Object.values(USERS)) {
        if (await panelCanSee(userId, appBlockId)) panel.push(userId);
        if (await ingestTeam(userId, appBlockId)) team.push(userId);
      }
      const expected = [...EXPECTED_TEAM[appBlockId]].sort((a, b) => a - b);
      expect(panel.sort((a, b) => a - b)).toEqual(expected);
      expect(team.sort((a, b) => a - b)).toEqual(expected);
    });
  }

  it('POSITIVE CONTROL: the evaluator separates accepted from pending at all', async () => {
    const accepted = await table(seats)({ where: { status: 'accepted' } });
    const any = await table(seats)({});
    expect(accepted.length).toBe(5);
    expect(any.length).toBe(7);
  });

  it('NEGATIVE CONTROL: an operator the evaluator does not know throws', async () => {
    await expect(table(seats)({ where: { status: { notIn: ['pending'] } } })).rejects.toThrow(
      'unsupported'
    );
    await expect(table(seats)({ where: { OR: [] } })).rejects.toThrow('unsupported');
  });
});
