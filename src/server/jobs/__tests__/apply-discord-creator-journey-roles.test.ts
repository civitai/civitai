import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FlagService from '~/server/services/creator-journey-flag.service';
import type * as ConfigService from '~/server/services/creator-journey-config.service';
import type * as MetricExcluded from '~/server/services/metric-excluded-users.service';

const { mockDiscord, mockPgRead, mockAudience, mockConfig } = vi.hoisted(() => ({
  mockDiscord: { getAllRoles: vi.fn(), addRoleToUser: vi.fn(), removeRoleFromUser: vi.fn() },
  mockPgRead: { cancellableQuery: vi.fn() },
  mockAudience: vi.fn(),
  mockConfig: vi.fn(),
}));

vi.mock('~/server/integrations/discord', () => ({ discord: mockDiscord }));
vi.mock('~/server/db/pgDb', () => ({ pgDbRead: mockPgRead }));
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
}));
vi.mock('~/server/services/creator-journey-config.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ConfigService>()),
  getCreatorJourneyConfig: mockConfig,
}));
vi.mock('~/server/services/metric-excluded-users.service', async (importOriginal) => ({
  ...(await importOriginal<typeof MetricExcluded>()),
  getMetricExcludedUserIdsOrThrow: vi.fn().mockResolvedValue([]),
}));

import { applyDiscordCreatorJourneyRoles } from '~/server/jobs/apply-discord-roles';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';

const SUPERNOVA = { id: '100000000000000001', name: 'Supernova' };
const LEGEND = { id: '100000000000000002', name: 'Legend' };
const UNRELATED = { id: '100000000000000003', name: 'Creator' };
const ROLES = [SUPERNOVA, LEGEND, UNRELATED];
const CONFIG = { supernovaRoleId: SUPERNOVA.id, legendRoleId: LEGEND.id };

type Row = { milestoneKey: string; userId: number; providerAccountId: string };
type RawCall = [TemplateStringsArray, ...unknown[]];

let holderRows: Row[];
let accountsInRole: Record<string, string[]>;

const supernova = (userId: number, providerAccountId: string): Row => ({
  milestoneKey: 'score:supernova',
  userId,
  providerAccountId,
});
const legend = (userId: number, providerAccountId: string): Row[] => [
  supernova(userId, providerAccountId),
  { milestoneKey: 'score:legend', userId, providerAccountId },
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

beforeEach(() => {
  vi.clearAllMocks();
  holderRows = [];
  accountsInRole = {};
  mockConfig.mockResolvedValue(CONFIG);
  mockDiscord.addRoleToUser.mockResolvedValue(true);
  mockDiscord.removeRoleFromUser.mockResolvedValue(true);
  mockPgRead.cancellableQuery.mockImplementation(async () => ({
    result: async () => holderRows,
    cancel: async () => undefined,
  }));
  mockAudience.mockImplementation(async (_pg: unknown, userIds: number[]) => new Set(userIds));
  dbMock.dbWrite.$executeRaw.mockResolvedValue(0);
  // getAccountsInRole binds the role as a JSON array; answer per role.
  dbMock.dbWrite.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const role = ROLES.find((r) => values.includes(JSON.stringify([r.name])));
    return (accountsInRole[role?.name ?? ''] ?? []).map((providerAccountId) => ({
      providerAccountId,
    }));
  }) as never);
});

describe('applyDiscordCreatorJourneyRoles', () => {
  it('grants a Legend both roles and a Supernova only Supernova', async () => {
    holderRows = [...legend(1, '111'), supernova(2, '222')];

    await applyDiscordCreatorJourneyRoles(ROLES);

    expect(idsWritten('grant', 'Supernova')).toEqual(['111', '222']);
    expect(idsWritten('grant', 'Legend')).toEqual(['111']);
    expect(mockDiscord.addRoleToUser).toHaveBeenCalledWith('111', LEGEND.id);
    expect(mockDiscord.addRoleToUser).not.toHaveBeenCalledWith('222', LEGEND.id);
  });

  it('withholds the role from a holder the creator-journey flag is off for, and revokes it', async () => {
    holderRows = [supernova(1, '111'), supernova(2, '222')];
    accountsInRole = { Supernova: ['222'] };
    mockAudience.mockResolvedValue(new Set([1]));

    await applyDiscordCreatorJourneyRoles(ROLES);

    expect(idsWritten('grant', 'Supernova')).toEqual(['111']);
    expect(idsWritten('revoke', 'Supernova')).toEqual(['222']);
  });

  it('skips only the tier whose role id is not configured', async () => {
    mockConfig.mockResolvedValue({ supernovaRoleId: SUPERNOVA.id });
    holderRows = legend(1, '111');
    accountsInRole = { Legend: ['999'] };

    await applyDiscordCreatorJourneyRoles(ROLES);

    expect(idsWritten('grant', 'Supernova')).toEqual(['111']);
    expect(mockDiscord.addRoleToUser).not.toHaveBeenCalledWith(expect.anything(), LEGEND.id);
    expect(mockDiscord.removeRoleFromUser).not.toHaveBeenCalled();
  });

  it('touches nothing when the configured id is not a role in the guild', async () => {
    mockConfig.mockResolvedValue({
      supernovaRoleId: '200000000000000001',
      legendRoleId: '200000000000000002',
    });
    holderRows = legend(1, '111');

    await applyDiscordCreatorJourneyRoles(ROLES);

    expect(mockPgRead.cancellableQuery).not.toHaveBeenCalled();
    expect(mockDiscord.addRoleToUser).not.toHaveBeenCalled();
  });

  // Flipt unreachable evaluates the flag false for everyone. Under REVOKE_FLOOR holders,
  // withinBlastRadius passes anything, so this is the only thing between an outage and a mass strip.
  it('revokes nobody when no holder qualifies while the role has holders', async () => {
    holderRows = [supernova(1, '111'), supernova(2, '222')];
    accountsInRole = { Supernova: ['111', '222'] };
    mockAudience.mockResolvedValue(new Set());

    await applyDiscordCreatorJourneyRoles(ROLES);

    expect(mockDiscord.removeRoleFromUser).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('reads holders under the showcase standing rule', async () => {
    await applyDiscordCreatorJourneyRoles(ROLES);

    const [sql, params] = mockPgRead.cancellableQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('NOT u.muted');
    expect(sql).toContain('"UserStrike"');
    expect(params[0]).toEqual(['score:supernova', 'score:legend']);
  });
});
