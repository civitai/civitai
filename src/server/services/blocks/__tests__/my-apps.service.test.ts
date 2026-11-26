import { describe, expect, it, vi } from 'vitest';
import type { MyAppsDeps } from '~/server/services/blocks/my-apps.service';
import {
  listMyApps,
  MY_APPS_CONSENT_TAKE,
  MY_APPS_ENTITLEMENT_TAKE,
  MY_APPS_GRANT_TAKE,
  MY_APPS_INVOCATION_TAKE,
} from '~/server/services/blocks/my-apps.service';
import type { StoreListingCandidate } from '~/server/services/blocks/app-listing.service';

/**
 * The reads behind `appListings.listMyApps`, against an in-memory store seeded with TWO
 * users. The fake honours `where.userId` — the one predicate this file is about — so a read
 * that dropped or mis-keyed it would hand user 2's apps to user 1 here exactly as it would
 * against Postgres.
 */

type Row = Record<string, unknown> & { userId: number };

const NOW = new Date('2026-11-01T00:00:00.000Z');
const IN_WINDOW = new Date('2026-10-20T00:00:00.000Z');
const OUT_OF_WINDOW = new Date('2026-09-01T00:00:00.000Z');

const TABLES: Record<string, Row[]> = {
  appUserScopeGrant: [
    {
      userId: 1,
      appBlockId: 'blk_u1_grant',
      grantedAt: new Date('2026-10-02T00:00:00.000Z'),
      revokedAt: null,
    },
    {
      userId: 2,
      appBlockId: 'blk_u2_grant',
      grantedAt: new Date('2026-10-03T00:00:00.000Z'),
      revokedAt: null,
    },
  ],
  blockGoodEntitlement: [
    {
      userId: 1,
      appBlockId: 'blk_u1_good',
      grantedAt: new Date('2026-10-04T00:00:00.000Z'),
      revokedAt: null,
    },
    {
      userId: 2,
      appBlockId: 'blk_u2_good',
      grantedAt: new Date('2026-10-05T00:00:00.000Z'),
      revokedAt: null,
    },
  ],
  blockScopeInvocation: [
    { userId: 1, appBlockId: 'blk_u1_used', invokedAt: IN_WINDOW },
    { userId: 1, appBlockId: 'blk_u1_stale', invokedAt: OUT_OF_WINDOW },
    { userId: 2, appBlockId: 'blk_u2_used', invokedAt: IN_WINDOW },
  ],
  oauthConsent: [
    { userId: 1, clientId: 'cli_u1', updatedAt: new Date('2026-10-06T00:00:00.000Z') },
    { userId: 2, clientId: 'cli_u2', updatedAt: new Date('2026-10-07T00:00:00.000Z') },
  ],
};

type Where = {
  userId?: number;
  revokedAt?: null;
  invokedAt?: { gte: Date };
  appBlockId?: { not: null };
};

function fakeDb() {
  const calls: { table: string; args: { where: Where; take?: number } }[] = [];
  const table = (name: string) => ({
    findMany: vi.fn(async (args: { where: Where; take?: number }) => {
      calls.push({ table: name, args });
      const { where } = args;
      return TABLES[name]
        .filter((r) => r.userId === where.userId)
        .filter((r) => (where.revokedAt === null ? r.revokedAt == null : true))
        .filter((r) =>
          where.invokedAt ? (r.invokedAt as Date).getTime() >= where.invokedAt.gte.getTime() : true
        )
        .filter((r) => (where.appBlockId ? r.appBlockId != null : true))
        .slice(0, args.take);
    }),
  });
  const db = {
    appUserScopeGrant: table('appUserScopeGrant'),
    blockGoodEntitlement: table('blockGoodEntitlement'),
    blockScopeInvocation: table('blockScopeInvocation'),
    oauthConsent: table('oauthConsent'),
  };
  return { db: db as unknown as MyAppsDeps['db'], calls };
}

/** One visible listing per App Block / client id the loader is asked about. */
function fakeLoader() {
  return vi.fn(
    async (links: { appBlockIds: readonly string[]; connectClientIds: readonly string[] }) => {
      const onsite: StoreListingCandidate[] = links.appBlockIds.map((blk) => ({
        card: {
          id: `apl_${blk}`,
          slug: `slug-${blk}`,
          name: `Name ${blk}`,
          category: null,
          kind: 'onsite',
          kindData: {
            kind: 'onsite',
            appBlockId: blk,
            hasPage: true,
            liveUrl: 'https://x.invalid',
          },
          iconUrl: null,
          coverUrl: null,
        } as StoreListingCandidate['card'],
        appBlockId: blk,
        connectClientId: null,
        gate: {
          row: { status: 'approved', kind: 'onsite', contentRating: 'g', revisionOfId: null },
          visibility: null,
          deployedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      }));
      const offsite: StoreListingCandidate[] = links.connectClientIds.map((cli) => ({
        card: {
          id: `apl_${cli}`,
          slug: `slug-${cli}`,
          name: `Name ${cli}`,
          category: null,
          kind: 'offsite',
          kindData: { kind: 'offsite', externalUrl: `https://${cli}.example.org` },
          iconUrl: null,
          coverUrl: null,
        } as StoreListingCandidate['card'],
        appBlockId: null,
        connectClientId: cli,
        gate: {
          row: { status: 'approved', kind: 'offsite', contentRating: null, revisionOfId: null },
          visibility: null,
          deployedAt: null,
        },
      }));
      return [...onsite, ...offsite];
    }
  );
}

const noHides = vi.fn(async () => ({}));

const ARGS = {
  scope: 'full' as const,
  floor: 'public' as const,
  redCapable: false,
  canOpenPage: true,
};

describe('listMyApps — reads only the caller’s rows', () => {
  it('🔴 user 1 gets user 1’s apps and none of user 2’s', async () => {
    const { db } = fakeDb();
    const loadCandidates = fakeLoader();
    const { apps: rows } = await listMyApps(
      { ...ARGS, userId: 1 },
      { db, loadCandidates, loadHidden: noHides, now: () => NOW }
    );

    expect(rows.map((r) => r.listingId).sort()).toEqual([
      'apl_blk_u1_good',
      'apl_blk_u1_grant',
      'apl_blk_u1_used',
      'apl_cli_u1',
    ]);
    // The listing lookup was never even ASKED about user 2's ids (or the stale invocation).
    const [links] = loadCandidates.mock.calls[0];
    expect([...links.appBlockIds].sort()).toEqual(['blk_u1_good', 'blk_u1_grant', 'blk_u1_used']);
    expect([...links.connectClientIds]).toEqual(['cli_u1']);
  });

  it('user 2 gets exactly user 2’s apps (the mirror — the fixture is not one-sided)', async () => {
    const { db } = fakeDb();
    const { apps: rows } = await listMyApps(
      { ...ARGS, userId: 2 },
      { db, loadCandidates: fakeLoader(), loadHidden: noHides, now: () => NOW }
    );
    expect(rows.map((r) => r.listingId).sort()).toEqual([
      'apl_blk_u2_good',
      'apl_blk_u2_grant',
      'apl_blk_u2_used',
      'apl_cli_u2',
    ]);
  });

  it('every read is keyed on the caller and carries a row cap; the invocation read is windowed', async () => {
    const { db, calls } = fakeDb();
    await listMyApps(
      { ...ARGS, userId: 1 },
      { db, loadCandidates: fakeLoader(), loadHidden: noHides, now: () => NOW }
    );

    expect(calls.map((c) => c.table).sort()).toEqual([
      'appUserScopeGrant',
      'blockGoodEntitlement',
      'blockScopeInvocation',
      'oauthConsent',
    ]);
    for (const c of calls) expect(c.args.where.userId, c.table).toBe(1);
    const take = Object.fromEntries(calls.map((c) => [c.table, c.args.take]));
    expect(take).toEqual({
      appUserScopeGrant: MY_APPS_GRANT_TAKE,
      blockGoodEntitlement: MY_APPS_ENTITLEMENT_TAKE,
      blockScopeInvocation: MY_APPS_INVOCATION_TAKE,
      oauthConsent: MY_APPS_CONSENT_TAKE,
    });
    // 30 days before NOW.
    const inv = calls.find((c) => c.table === 'blockScopeInvocation');
    expect(inv?.args.where.invokedAt?.gte.toISOString()).toBe('2026-10-02T00:00:00.000Z');
  });

  it('a user with no rows issues no listing lookup at all', async () => {
    const { db } = fakeDb();
    const loadCandidates = fakeLoader();
    const res = await listMyApps(
      { ...ARGS, userId: 3 },
      { db, loadCandidates, loadHidden: noHides, now: () => NOW }
    );
    expect(res).toEqual({ apps: [], removedCount: 0, removedSlugsByListingId: {}, hidden: {} });
    expect(loadCandidates).not.toHaveBeenCalled();
  });
});

describe('listMyApps — the caller’s hides', () => {
  it('🔴 reads the CALLER’s hides, drops a hidden row, and returns the hides and the count', async () => {
    const { db } = fakeDb();
    // u1's grant app was used 2026-10-02; this hide is after that, so it is in force. The
    // off-site consent (2026-10-06) is newer than its hide (2026-10-05), so it stays.
    const hides = {
      'slug-blk_u1_grant': '2026-10-02T12:00:00.000Z',
      'slug-cli_u1': '2026-10-05T00:00:00.000Z',
    };
    const loadHidden = vi.fn<(userId: number) => Promise<typeof hides>>(async () => hides);
    const res = await listMyApps(
      { ...ARGS, userId: 1 },
      { db, loadCandidates: fakeLoader(), loadHidden, now: () => NOW }
    );
    expect(loadHidden.mock.calls).toEqual([[1]]);
    expect(res.apps.map((r) => r.listingId).sort()).toEqual([
      'apl_blk_u1_good',
      'apl_blk_u1_used',
      'apl_cli_u1',
    ]);
    expect(res.removedCount).toBe(1);
    expect(res.removedSlugsByListingId).toStrictEqual({ apl_blk_u1_grant: 'slug-blk_u1_grant' });
    expect(res.hidden).toEqual(hides);
  });
});
