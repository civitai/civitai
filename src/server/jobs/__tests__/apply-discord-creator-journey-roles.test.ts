import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FlagService from '~/server/services/creator-journey-flag.service';
import type * as ConfigService from '~/server/services/creator-journey-config.service';
import type * as MetricExcluded from '~/server/services/metric-excluded-users.service';

const { mockDiscord, mockPgRead, mockAudience, mockReadable, mockConfig, mockExcluded } =
  vi.hoisted(() => ({
    mockDiscord: { getAllRoles: vi.fn(), addRoleToUser: vi.fn(), removeRoleFromUser: vi.fn() },
    mockPgRead: { cancellableQuery: vi.fn() },
    mockAudience: vi.fn(),
    mockReadable: vi.fn(),
    mockConfig: vi.fn(),
    mockExcluded: vi.fn(),
  }));

vi.mock('~/server/integrations/discord', () => ({ discord: mockDiscord }));
vi.mock('~/server/db/pgDb', () => ({ pgDbRead: mockPgRead, pgDbReadLong: {}, pgDbWrite: {} }));
vi.mock('~/server/jobs/job', () => ({
  createJob: (name: string, cron: string, fn: (e: unknown) => Promise<unknown>) => ({
    name,
    cron,
    run: () => fn(undefined),
  }),
}));
vi.mock('~/server/services/creator-journey-flag.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FlagService>()),
  creatorJourneyAudienceAmong: mockAudience,
  isCreatorJourneyFlagReadable: mockReadable,
}));
vi.mock('~/server/services/creator-journey-config.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ConfigService>()),
  getCreatorJourneyConfig: mockConfig,
}));
vi.mock('~/server/services/metric-excluded-users.service', async (importOriginal) => ({
  ...(await importOriginal<typeof MetricExcluded>()),
  getMetricExcludedUserIdsOrThrow: mockExcluded,
}));

import {
  applyDiscordCreatorJourneyRoles,
  applyDiscordRoles,
} from '~/server/jobs/apply-discord-roles';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';

const SUPERNOVA = { id: '100000000000000001', name: 'Supernova' };
const LEGEND = { id: '100000000000000002', name: 'Legend' };
const UNRELATED = { id: '100000000000000003', name: 'Creator' };
const ROLES = [SUPERNOVA, LEGEND, UNRELATED];
const CONFIG = { supernovaRoleId: SUPERNOVA.id, legendRoleId: LEGEND.id };

type Row = {
  milestoneKey: string;
  userId: number;
  isModerator: boolean;
  providerAccountId: string;
};
type RawCall = [TemplateStringsArray, ...unknown[]];

let holderRows: Row[];
let accountsInRole: Record<string, string[]>;

const supernova = (userId: number, providerAccountId: string, isModerator = false): Row => ({
  milestoneKey: 'score:supernova',
  userId,
  isModerator,
  providerAccountId,
});
const legend = (userId: number, providerAccountId: string, isModerator = false): Row[] => [
  supernova(userId, providerAccountId, isModerator),
  { milestoneKey: 'score:legend', userId, isModerator, providerAccountId },
];

// Same decoding as apply-discord-roles.test.ts: only a grant binds the role as a JSON array.
function idsWritten(kind: 'grant' | 'revoke', roleName: string) {
  const appended = JSON.stringify([roleName]);
  return (dbMock.dbWrite.$executeRaw.mock.calls as RawCall[])
    .map(([strings, ...values]) => Prisma.sql(strings, ...values))
    .filter(
      (query) =>
        query.values.includes(roleName) && query.values.includes(appended) === (kind === 'grant')
    )
    .flatMap((query) =>
      query.values.filter(
        (v): v is string => typeof v === 'string' && v !== roleName && v !== appended
      )
    )
    .sort();
}

/** Flipt unreachable: moderators are on without asking it, everyone else evaluates false. */
const flagDown = () => {
  mockReadable.mockResolvedValue(false);
  mockAudience.mockImplementation(
    async (_pg: unknown, userIds: number[]) =>
      new Set(userIds.filter((id) => holderRows.some((r) => r.userId === id && r.isModerator)))
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  holderRows = [];
  accountsInRole = {};
  mockConfig.mockResolvedValue(CONFIG);
  mockExcluded.mockResolvedValue([]);
  mockDiscord.getAllRoles.mockResolvedValue(ROLES);
  mockDiscord.addRoleToUser.mockResolvedValue(true);
  mockDiscord.removeRoleFromUser.mockResolvedValue(true);
  mockPgRead.cancellableQuery.mockImplementation(async () => ({
    result: async () => holderRows,
    cancel: async () => undefined,
  }));
  mockAudience.mockImplementation(async (_pg: unknown, userIds: number[]) => new Set(userIds));
  mockReadable.mockResolvedValue(true);
  dbMock.dbWrite.$executeRaw.mockResolvedValue(0);
  dbMock.dbWrite.model.findMany.mockResolvedValue([]);
  // getAccountsInRole binds the role as a JSON array; answer per role.
  dbMock.dbWrite.$queryRaw.mockImplementation((async (
    _strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const role = ROLES.find((r) => values.includes(JSON.stringify([r.name])));
    return (accountsInRole[role?.name ?? ''] ?? []).map((providerAccountId) => ({
      providerAccountId,
    }));
  }) as never);
});

describe('applyDiscordCreatorJourneyRoles — grants', () => {
  it('grants a Legend both roles and a Supernova only Supernova', async () => {
    holderRows = [...legend(1, '111'), supernova(2, '222')];

    await applyDiscordCreatorJourneyRoles(ROLES);

    expect(idsWritten('grant', 'Supernova')).toEqual(['111', '222']);
    expect(idsWritten('grant', 'Legend')).toEqual(['111']);
    expect(mockDiscord.addRoleToUser).toHaveBeenCalledWith('111', LEGEND.id);
    expect(mockDiscord.addRoleToUser).not.toHaveBeenCalledWith('222', LEGEND.id);
    expect(mockDiscord.addRoleToUser).not.toHaveBeenCalledWith(expect.anything(), UNRELATED.id);
  });

  it('does not re-grant an account that already holds the role', async () => {
    holderRows = [supernova(1, '111'), supernova(2, '222')];
    accountsInRole = { Supernova: ['111'] };

    await applyDiscordCreatorJourneyRoles(ROLES);

    expect(idsWritten('grant', 'Supernova')).toEqual(['222']);
    expect(mockDiscord.addRoleToUser).not.toHaveBeenCalledWith('111', SUPERNOVA.id);
  });

  it('runs as part of the activity-roles job', async () => {
    holderRows = legend(1, '111');
    const [activityJob] = applyDiscordRoles as unknown as { run: () => Promise<unknown> }[];

    await activityJob.run();

    expect(mockDiscord.addRoleToUser).toHaveBeenCalledWith('111', LEGEND.id);
  });
});

describe('applyDiscordCreatorJourneyRoles — revokes', () => {
  it('withholds and revokes the role for a holder the flag is off for', async () => {
    holderRows = [supernova(1, '111'), supernova(2, '222')];
    accountsInRole = { Supernova: ['222'] };
    mockAudience.mockResolvedValue(new Set([1]));

    await applyDiscordCreatorJourneyRoles(ROLES);

    expect(idsWritten('grant', 'Supernova')).toEqual(['111']);
    expect(idsWritten('revoke', 'Supernova')).toEqual(['222']);
  });

  // Moderators are on without asking Flipt, so an outage leaves them qualifying. Reading "everyone
  // else is off" as real would strip every non-moderator holder for up to six hours.
  it('revokes nobody for flag reasons while Flipt is unreadable', async () => {
    holderRows = [supernova(1, '111', true), supernova(2, '222'), supernova(3, '333')];
    accountsInRole = { Supernova: ['111', '222', '333'] };
    flagDown();

    await applyDiscordCreatorJourneyRoles(ROLES);

    expect(mockDiscord.removeRoleFromUser).not.toHaveBeenCalled();
    expect(idsWritten('revoke', 'Supernova')).toEqual([]);
  });

  it('still revokes on lost standing while Flipt is unreadable, and grants only the flagged', async () => {
    holderRows = [supernova(1, '111', true), supernova(2, '222'), supernova(3, '333')];
    accountsInRole = { Supernova: ['222', '999'] };
    flagDown();

    await applyDiscordCreatorJourneyRoles(ROLES);

    expect(idsWritten('revoke', 'Supernova')).toEqual(['999']);
    expect(idsWritten('grant', 'Supernova')).toEqual(['111']);
  });

  // Winding the tester phase down turns the flag off for every non-moderator holder. Flipt is up,
  // so that is a real answer, and the roles (and the Legends channel) must go with it.
  it('revokes every non-moderator holder when a readable flag is off for all of them', async () => {
    holderRows = [...legend(1, '111', true), ...legend(2, '222'), ...legend(3, '333')];
    accountsInRole = { Legend: ['111', '222', '333'] };
    mockAudience.mockResolvedValue(new Set([1]));

    await applyDiscordCreatorJourneyRoles(ROLES);

    expect(idsWritten('revoke', 'Legend')).toEqual(['222', '333']);
  });

  // With two Legends, both being banned is a real state; the role must not outlive their standing.
  it('revokes the last holders when none is in good standing any more', async () => {
    holderRows = [];
    accountsInRole = { Legend: ['111', '222'] };

    await applyDiscordCreatorJourneyRoles(ROLES);

    expect(idsWritten('revoke', 'Legend')).toEqual(['111', '222']);
  });

  it('refuses a bulk revoke past the blast-radius floor', async () => {
    const holders = Array.from({ length: 12 }, (_, i) => `${200 + i}`);
    holderRows = [supernova(1, '200')];
    accountsInRole = { Supernova: holders };

    await applyDiscordCreatorJourneyRoles(ROLES);

    expect(mockDiscord.removeRoleFromUser).not.toHaveBeenCalled();
  });
});

describe('applyDiscordCreatorJourneyRoles — config and inputs', () => {
  it('skips only the tier whose role id is not configured', async () => {
    mockConfig.mockResolvedValue({ supernovaRoleId: SUPERNOVA.id });
    holderRows = legend(1, '111');
    accountsInRole = { Legend: ['999'] };

    await applyDiscordCreatorJourneyRoles(ROLES);

    expect(idsWritten('grant', 'Supernova')).toEqual(['111']);
    expect(mockDiscord.addRoleToUser).not.toHaveBeenCalledWith(expect.anything(), LEGEND.id);
    expect(mockDiscord.removeRoleFromUser).not.toHaveBeenCalled();
  });

  it('touches nothing when the configured ids are not roles in the guild', async () => {
    mockConfig.mockResolvedValue({
      supernovaRoleId: '200000000000000001',
      legendRoleId: '200000000000000002',
    });
    holderRows = legend(1, '111');

    await applyDiscordCreatorJourneyRoles(ROLES);

    expect(mockPgRead.cancellableQuery).not.toHaveBeenCalled();
    expect(mockDiscord.addRoleToUser).not.toHaveBeenCalled();
  });

  // One role on both tiers would be granted by one pass and stripped by the other, every run.
  it('touches nothing when both tiers point at the same role', async () => {
    mockConfig.mockResolvedValue({ supernovaRoleId: SUPERNOVA.id, legendRoleId: SUPERNOVA.id });
    holderRows = [...legend(1, '111'), supernova(2, '222')];
    accountsInRole = { Supernova: ['111', '222'] };

    await applyDiscordCreatorJourneyRoles(ROLES);

    expect(mockDiscord.addRoleToUser).not.toHaveBeenCalled();
    expect(mockDiscord.removeRoleFromUser).not.toHaveBeenCalled();
  });

  it('makes no Discord call when the metric-excluded list cannot be read', async () => {
    mockExcluded.mockRejectedValue(new Error('clickhouse unavailable'));
    accountsInRole = { Supernova: ['111'] };

    await expect(applyDiscordCreatorJourneyRoles(ROLES)).rejects.toThrow('clickhouse unavailable');
    expect(mockDiscord.addRoleToUser).not.toHaveBeenCalled();
    expect(mockDiscord.removeRoleFromUser).not.toHaveBeenCalled();
  });

  // Read first, so the audience comes from an initialised client: evaluated cold, everyone but
  // moderators is false, and a "readable" check after that would trust it and revoke them all.
  it('checks the flag is readable before evaluating the audience', async () => {
    holderRows = [supernova(1, '111')];
    await applyDiscordCreatorJourneyRoles(ROLES);
    expect(mockReadable.mock.invocationCallOrder[0]).toBeLessThan(
      mockAudience.mock.invocationCallOrder[0]
    );
  });

  it('reads holders under the showcase standing rule, with its bind values', async () => {
    mockExcluded.mockResolvedValue([42, 43]);
    const now = new Date('2026-10-08T12:00:00.000Z');

    await applyDiscordCreatorJourneyRoles(ROLES, now);

    const [sql, params] = mockPgRead.cancellableQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(`a.provider = 'discord'`);
    expect(sql).toContain('ucm."milestoneKey" = ANY($1::text[])');
    expect(sql).toContain('u.id <> ALL($2::int[])');
    expect(sql).toContain('s."expiresAt" > $3::timestamp');
    expect(sql).toContain('NOT u.muted');
    expect(sql).toContain('"UserStrike"');
    expect(params).toEqual([
      ['score:supernova', 'score:legend'],
      [42, 43],
      '2026-10-08 12:00:00.000',
    ]);
  });
});
