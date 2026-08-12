import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Account.metadata->'roles' is our only record of what Discord has, and it is also the skip list for the next
 * run. So writing it for an account Discord rejected is unrecoverable: the user never gets the role and we
 * never try again. These pin that the write follows Discord's answer, per account.
 */

const { mockDbWrite, mockDiscord } = vi.hoisted(() => ({
  mockDbWrite: {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    user: { findMany: vi.fn(), findUnique: vi.fn() },
  },
  mockDiscord: {
    getAllRoles: vi.fn(),
    addRoleToUser: vi.fn(),
    removeRoleFromUser: vi.fn(),
  },
}));

vi.mock('~/server/db/client', () => ({ dbWrite: mockDbWrite }));
vi.mock('~/server/integrations/discord', () => ({ discord: mockDiscord }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn() }));
vi.mock('~/server/jobs/job', () => ({
  createJob: (name: string, cron: string, fn: (e: unknown) => Promise<unknown>) => ({
    name,
    cron,
    run: () => fn(undefined),
  }),
  getJobDate: vi.fn().mockResolvedValue([new Date(0), vi.fn()]),
}));

import {
  applyDiscordLeaderboardRoles,
  syncUserDiscordLeaderboardRoles,
} from '~/server/jobs/apply-discord-roles';

const TOP_10 = { id: 'role-10', name: 'Top 10' };
const TOP_100 = { id: 'role-100', name: 'Top 100' };

type RawCall = [TemplateStringsArray, ...unknown[]];

// The metadata writes are tagged templates, so recover each one's bound params and read back the
// providerAccountIds it touched. Only a grant binds the role as a JSON array (the value it appends); both bind
// the bare name (the value they subtract), so that pair identifies the direction without reading the SQL text.
function idsWritten(kind: 'grant' | 'revoke', roleName: string) {
  const appended = JSON.stringify([roleName]);
  return (mockDbWrite.$executeRaw.mock.calls as RawCall[])
    .map(([strings, ...values]) => Prisma.sql(strings, ...values))
    .filter(
      (query) =>
        query.values.includes(roleName) && query.values.includes(appended) === (kind === 'grant')
    )
    .flatMap((query) =>
      query.values.filter(
        (v): v is string => typeof v === 'string' && v !== roleName && v !== appended
      )
    );
}

function topUser(rank: number, providerAccountId: string) {
  return { rank: { leaderboardRank: rank }, accounts: [{ providerAccountId }] };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDbWrite.$executeRaw.mockResolvedValue(undefined);
  mockDiscord.getAllRoles.mockResolvedValue([TOP_10, TOP_100]);
  mockDiscord.addRoleToUser.mockResolvedValue(true);
  mockDiscord.removeRoleFromUser.mockResolvedValue(true);
  // getAccountsInRole: Top 100 first, then Top 10.
  mockDbWrite.$queryRaw.mockResolvedValue([]);
  mockDbWrite.user.findMany.mockResolvedValue([]);
});

describe('applyDiscordLeaderboardRoles — metadata must follow Discord', () => {
  it('does not record the role for an account Discord rejected', async () => {
    mockDbWrite.user.findMany.mockResolvedValue([topUser(5, '111'), topUser(50, '222')]);
    mockDiscord.addRoleToUser.mockImplementation(async (providerAccountId: string) => {
      if (providerAccountId === '222') throw new Error('Missing Access');
      return true;
    });

    await applyDiscordLeaderboardRoles();

    expect(idsWritten('grant', 'Top 100')).toEqual(['111']);
  });

  it('does not record the role for a user who has not joined the guild', async () => {
    mockDbWrite.user.findMany.mockResolvedValue([topUser(5, '111'), topUser(50, '222')]);
    // addRoleToUser resolves false for an unknown member — nothing was granted, so it must stay retryable.
    mockDiscord.addRoleToUser.mockImplementation(async (providerAccountId: string) => {
      return providerAccountId !== '222';
    });

    await applyDiscordLeaderboardRoles();

    expect(idsWritten('grant', 'Top 100')).toEqual(['111']);
  });

  it('writes nothing when every Discord call fails', async () => {
    mockDbWrite.user.findMany.mockResolvedValue([topUser(5, '111')]);
    mockDiscord.addRoleToUser.mockRejectedValue(new Error('Service Unavailable'));

    await applyDiscordLeaderboardRoles();

    expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('keeps every account of a user with more than one linked Discord row', async () => {
    mockDbWrite.user.findMany.mockResolvedValue([
      {
        rank: { leaderboardRank: 5 },
        accounts: [{ providerAccountId: '111' }, { providerAccountId: '333' }],
      },
    ]);

    await applyDiscordLeaderboardRoles();

    expect(idsWritten('grant', 'Top 100').sort()).toEqual(['111', '333']);
  });
});

describe('applyDiscordLeaderboardRoles — Top 10 removal', () => {
  it('revokes Top 10 from a user who fell out of the top 10 but is still in the top 100', async () => {
    mockDbWrite.user.findMany.mockResolvedValue([topUser(50, '222')]);
    mockDbWrite.$queryRaw
      .mockResolvedValueOnce([{ providerAccountId: '222' }]) // already has Top 100
      .mockResolvedValueOnce([{ providerAccountId: '222' }]); // and still has Top 10

    await applyDiscordLeaderboardRoles();

    expect(mockDiscord.removeRoleFromUser).toHaveBeenCalledWith('222', TOP_10.id);
    expect(idsWritten('revoke', 'Top 10')).toEqual(['222']);
    expect(mockDiscord.removeRoleFromUser).not.toHaveBeenCalledWith('222', TOP_100.id);
  });

  // The job no longer refuses to run on a partially populated leaderboard, so an empty UserRank reaches this
  // code instead of being filtered out upstream. Reading it as "everyone left the top 100" would strip the role
  // from every holder in one run.
  it('strips nobody when no ranked user has a linked Discord account', async () => {
    mockDbWrite.user.findMany.mockResolvedValue([]);
    mockDbWrite.$queryRaw
      .mockResolvedValueOnce([{ providerAccountId: '111' }, { providerAccountId: '222' }])
      .mockResolvedValueOnce([{ providerAccountId: '111' }]);

    await applyDiscordLeaderboardRoles();

    expect(mockDiscord.removeRoleFromUser).not.toHaveBeenCalled();
    expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  // Taking a role away from someone who has it is worse than failing to grant one, so the revoke direction gets
  // the same treatment: metadata follows Discord's answer per account.
  it('keeps the role recorded for an account whose revoke Discord rejected', async () => {
    const holders = [{ providerAccountId: '111' }, { providerAccountId: '222' }];
    mockDbWrite.user.findMany.mockResolvedValue([topUser(5, '333')]);
    mockDbWrite.$queryRaw.mockResolvedValueOnce(holders).mockResolvedValueOnce([]);
    mockDiscord.removeRoleFromUser.mockImplementation(async (providerAccountId: string) => {
      if (providerAccountId === '222') throw new Error('Missing Permissions');
      return true;
    });

    await applyDiscordLeaderboardRoles();

    expect(idsWritten('revoke', 'Top 100')).toEqual(['111']);
  });

  // updateLeaderboardRank({ leaderboardIds }) truncates UserRank and refills it with one event's users, so a
  // near-total revoke list means our view of who is ranked collapsed, not that the leaderboard emptied out.
  it('refuses to revoke in bulk when most holders would lose the role at once', async () => {
    const holders = Array.from({ length: 20 }, (_, i) => ({ providerAccountId: `${100 + i}` }));
    mockDbWrite.user.findMany.mockResolvedValue([topUser(5, '100')]);
    mockDbWrite.$queryRaw.mockResolvedValueOnce(holders).mockResolvedValueOnce([]);

    await applyDiscordLeaderboardRoles();

    expect(mockDiscord.removeRoleFromUser).not.toHaveBeenCalled();
  });
});

describe('syncUserDiscordLeaderboardRoles', () => {
  it('grants both roles to a top-10 user without revoking anything', async () => {
    mockDbWrite.user.findUnique.mockResolvedValue({
      rank: { leaderboardRank: 3 },
      accounts: [{ providerAccountId: '111' }],
    });

    await syncUserDiscordLeaderboardRoles(1);

    expect(idsWritten('grant', 'Top 100')).toEqual(['111']);
    expect(idsWritten('grant', 'Top 10')).toEqual(['111']);
    expect(mockDiscord.removeRoleFromUser).not.toHaveBeenCalled();
  });

  it('touches nothing for an unranked user', async () => {
    mockDbWrite.user.findUnique.mockResolvedValue({
      rank: null,
      accounts: [{ providerAccountId: '111' }],
    });

    await syncUserDiscordLeaderboardRoles(1);

    expect(mockDiscord.addRoleToUser).not.toHaveBeenCalled();
    expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
  });
});
