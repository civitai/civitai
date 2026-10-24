import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock, loggingMock } from '~/__tests__/mocks';
import { CrucibleSort, NsfwLevel } from '~/server/common/enums';
import { getEffectiveBrowsingLevel } from '~/server/games/daily-challenge/challenge-visibility';
import type * as ChallengeService from '~/server/services/challenge.service';
import type * as NotificationService from '~/server/services/notification.service';
import type * as ChallengeMetrics from '~/server/prom/challenge.metrics';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';

// Who sees a crucible or challenge after a text scan escalates it, end to end: the real text-scan
// action writes the level, and the real feed filter (or, for challenges, its SQL rule) decides.

vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: vi.fn(),
}));
vi.mock('~/server/services/challenge.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ChallengeService>()),
  voidChallenge: vi.fn(),
}));
vi.mock('~/server/prom/challenge.metrics', async (importOriginal) => ({
  ...(await importOriginal<typeof ChallengeMetrics>()),
  recordChallengeScanResult: vi.fn(),
}));

const { applyCrucibleTextScan } = await import('~/server/services/text-scan/actions/crucible');
const { applyChallengeTextScan } = await import('~/server/services/text-scan/actions/challenge');
const { getCrucibles } = await import('~/server/services/crucible.service');

const { PG, PG13, R, X, XXX } = NsfwLevel;
const SFW = PG | PG13;
const OWNER = 7;
const VIEWER = 99;

// `nsfwLevel` is left null so the actions must read the verdict's own detected level.
const scanArgs = (entityId: number, detectedLevel: number) =>
  ({
    entityId,
    workflowId: 'wf',
    outcome: {
      nsfw: { detectedLevel, declaredLevel: SFW, raised: true, reason: 'r' },
      triggeredLabels: ['nsfw'],
      nsfwLevel: null,
    },
    subject: { fields: [], declared: { nsfwLevel: SFW } },
  } as never);

type Viewer = { name: string; viewerId?: number; isGreen?: boolean; browsingLevel?: number };
const viewers: Viewer[] = [
  { name: 'signed out', browsingLevel: PG },
  { name: 'signed out, green', isGreen: true },
  { name: 'signed in, no level', viewerId: VIEWER },
  { name: 'PG', viewerId: VIEWER, browsingLevel: PG },
  { name: 'PG13 only', viewerId: VIEWER, browsingLevel: PG13 },
  { name: 'PG..PG13', viewerId: VIEWER, browsingLevel: SFW },
  { name: 'R only', viewerId: VIEWER, browsingLevel: R },
  { name: 'PG..R', viewerId: VIEWER, browsingLevel: SFW | R },
  { name: 'PG..X', viewerId: VIEWER, browsingLevel: SFW | R | X },
  { name: 'PG..XXX', viewerId: VIEWER, browsingLevel: SFW | R | X | XXX },
  { name: 'X..XXX only', viewerId: VIEWER, browsingLevel: X | XXX },
  { name: 'owner at PG', viewerId: OWNER, browsingLevel: PG },
  { name: 'owner, green', viewerId: OWNER, isGreen: true },
];
const xOnly = viewers.find((viewer) => viewer.name === 'X..XXX only')!;

beforeEach(() => {
  vi.clearAllMocks();
  loggingMock.logToAxiom.mockResolvedValue(undefined);
});

// Just enough of Prisma's where semantics for the shapes getCrucibles builds; anything else throws
// so a new filter shape fails here by name rather than passing silently.
function matches(row: Record<string, any>, where: Record<string, any>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (cond === undefined) return true;
    if (key === 'AND') return (cond as object[]).every((w) => matches(row, w as never));
    if (key === 'OR') return (cond as object[]).some((w) => matches(row, w as never));
    if (!(key in row)) throw new Error(`matches: the test row has no ${key}`);
    const value = row[key];
    if (cond === null || typeof cond !== 'object') return value === cond;
    const ops = Object.keys(cond);
    if (ops.length === 1 && ops[0] === 'in') return cond.in.includes(value);
    if (ops.length === 1 && ops[0] === 'notIn') return !cond.notIn.includes(value);
    if (value && typeof value === 'object' && !Array.isArray(value)) return matches(value, cond);
    throw new Error(`matches: unsupported filter on ${key}: ${JSON.stringify(cond)}`);
  });
}

describe('crucible escalated by a text scan', () => {
  const ID = 42;

  async function escalatedRow(detected: number, coverLevel = PG) {
    dbMock.dbWrite.crucible.findUnique.mockResolvedValue({
      userId: OWNER,
      nsfwLevel: SFW,
      buzzType: 'green',
      status: CrucibleStatus.Active,
      textNsfw: false,
      moderatorNsfwLevel: null,
    } as never);
    dbMock.dbWrite.crucible.updateMany.mockResolvedValue({ count: 1 } as never);
    await applyCrucibleTextScan(scanArgs(ID, detected));
    const { data } = dbMock.dbWrite.crucible.updateMany.mock.calls[0][0] as { data: any };
    return {
      userId: OWNER,
      ingestion: data.ingestion,
      textNsfw: data.textNsfw,
      nsfwLevel: data.nsfwLevel as number,
      image: { ingestion: 'Scanned', nsfwLevel: coverLevel },
    };
  }

  // The real getCrucibles filter, per viewer; status is its own query split, not visibility.
  async function sees(row: Record<string, unknown>, viewer: Viewer) {
    const wheres: Record<string, any>[] = [];
    dbMock.dbRead.crucible.findMany.mockImplementation((async ({ where }: { where: object }) => {
      wheres.push({ ...where, status: undefined });
      return [];
    }) as never);
    await getCrucibles({
      input: { limit: 10, sort: CrucibleSort.Newest, browsingLevel: viewer.browsingLevel },
      select: { id: true },
      viewerId: viewer.viewerId,
      isGreen: viewer.isGreen,
    });
    expect(wheres.length).toBeGreaterThan(0);
    return wheres.some((where) => matches(row, where));
  }

  it.each([
    [R, SFW | R],
    [X, SFW | R | X],
    [XXX, SFW | R | X | XXX],
  ])('stores the detected level %s as %s', async (detected, stored) => {
    expect((await escalatedRow(detected)).nsfwLevel).toBe(stored);
  });

  // The crucible's level is also the set of entry ratings it accepts, so the feed shows it to any
  // viewer whose level overlaps it; its text flag is what keeps it from SFW-only viewers. Behind an
  // SFW cover that overlap is the same at every detected level.
  it.each([R, X, XXX])('behind an SFW cover, a %s detection reaches', async (detected) => {
    const row = await escalatedRow(detected);
    const visible: Record<string, boolean> = {};
    for (const viewer of viewers) visible[viewer.name] = await sees(row, viewer);
    expect(visible).toEqual({
      'signed out': false,
      'signed out, green': false,
      'signed in, no level': true,
      PG: false,
      'PG13 only': false,
      'PG..PG13': false,
      'R only': false,
      'PG..R': true,
      'PG..X': true,
      'PG..XXX': true,
      'X..XXX only': false,
      'owner at PG': true,
      'owner, green': true,
    });
  });

  it.each([
    [R, false],
    [X, true],
    [XXX, true],
  ])(
    'behind an XXX cover, a viewer who browses only X..XXX sees a %s detection: %s',
    async (detected, visible) => {
      expect(await sees(await escalatedRow(detected, XXX), xOnly)).toBe(visible);
    }
  );
});

describe('challenge escalated by a text scan', () => {
  const ID = 9;

  async function escalated(detected: number) {
    dbMock.dbWrite.challenge.findUnique.mockResolvedValue({
      allowedNsfwLevel: SFW,
      buzzType: 'yellow',
      source: 'User',
      createdById: OWNER,
      collectionId: 55,
      status: 'Active',
      moderatorNsfwLevel: null,
    } as never);
    dbMock.dbWrite.challenge.update.mockResolvedValue({} as never);
    dbMock.dbRead.collection.findUnique.mockResolvedValue({ metadata: {} } as never);
    dbMock.dbWrite.collection.updateMany.mockResolvedValue({ count: 1 } as never);
    await applyChallengeTextScan(scanArgs(ID, detected));
    const { data } = dbMock.dbWrite.challenge.update.mock.calls.at(-1)![0] as { data: any };
    return { nsfwLevel: data.nsfwLevel as number, ingestion: data.ingestion as string };
  }

  // A copy of getInfiniteChallenges' scan and level gates: hidden until Scanned, then
  // `(c."nsfwLevel" & level) <> 0` on the challenge and on its cover, both skipped for the creator,
  // and the level gate skipped when no level applies. The SQL itself is pinned in
  // challenge-feed-browsing-level.service.test.ts; a change there must be mirrored here.
  const sees = (
    challenge: { nsfwLevel: number; ingestion: string },
    viewer: Viewer,
    coverLevel = PG
  ) => {
    if (viewer.viewerId === OWNER) return true;
    if (challenge.ingestion !== 'Scanned') return false;
    const level = getEffectiveBrowsingLevel({
      isGreen: !!viewer.isGreen,
      isLoggedIn: viewer.viewerId != null,
      requested: viewer.browsingLevel,
    });
    return level === 0 || ((challenge.nsfwLevel & level) !== 0 && (coverLevel & level) !== 0);
  };

  const visibility = (challenge: { nsfwLevel: number; ingestion: string }) =>
    Object.fromEntries(viewers.map((viewer) => [viewer.name, sees(challenge, viewer)]));

  const everyoneBelowR = {
    'signed out': false,
    'signed out, green': false,
    'signed in, no level': true,
    PG: false,
    'PG13 only': false,
    'PG..PG13': false,
    'R only': false,
    'X..XXX only': false,
    'owner at PG': true,
    'owner, green': true,
  };

  it('an R detection reaches viewers who browse R', async () => {
    expect(visibility(await escalated(R))).toEqual({
      ...everyoneBelowR,
      'PG..R': true,
      'PG..X': true,
      'PG..XXX': true,
    });
  });

  it('an X detection is withheld from viewers who browse only up to R', async () => {
    expect(visibility(await escalated(X))).toEqual({
      ...everyoneBelowR,
      'PG..R': false,
      'PG..X': true,
      'PG..XXX': true,
    });
  });

  it('an XXX detection reaches only viewers who browse XXX', async () => {
    expect(visibility(await escalated(XXX))).toEqual({
      ...everyoneBelowR,
      'PG..R': false,
      'PG..X': false,
      'PG..XXX': true,
    });
  });

  it.each([
    [R, false],
    [X, true],
    [XXX, true],
  ])(
    'behind an XXX cover, a viewer who browses only X..XXX sees a %s detection: %s',
    async (detected, visible) => {
      expect(sees(await escalated(detected), xOnly, XXX)).toBe(visible);
    }
  );
});
