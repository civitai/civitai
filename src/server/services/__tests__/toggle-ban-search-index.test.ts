import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type * as HatSync from '~/server/events/points/sync';

/**
 * BANNING REMOVES AN ACCOUNT FROM USER SEARCH — SO LIFTING A BAN HAS TO PUT IT BACK.
 *
 * Nothing else would. The incremental user-index sync scans on `createdAt`, so it never revisits
 * an existing row, and the nightly reconciler only ever deletes. Without an explicit enqueue on
 * the unban branch the exclusion is a ONE-WAY DOOR: the account is restored everywhere except
 * search, indefinitely, and no signal says so.
 */

const {
  mockQueueUpdate,
  mockRemoveContent,
  mockInvalidateSession,
  mockCacheRefresh,
  mockSettingsBust,
  mockSendModerationEmail,
} = vi.hoisted(() => ({
  mockQueueUpdate: vi.fn(async () => undefined),
  mockRemoveContent: vi.fn(async () => undefined),
  mockInvalidateSession: vi.fn(async () => undefined),
  mockCacheRefresh: vi.fn(async () => undefined),
  mockSettingsBust: vi.fn(async () => undefined),
  mockSendModerationEmail: vi.fn(async (..._a: unknown[]) => undefined),
}));

vi.mock('~/server/email/templates', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, moderationActionEmail: { send: mockSendModerationEmail } };
});

vi.mock('~/server/search-index', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, usersSearchIndex: { queueUpdate: mockQueueUpdate } };
});
vi.mock('~/server/meilisearch/util', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, removeUserContentFromSearchIndex: mockRemoveContent };
});
vi.mock('~/server/auth/session-invalidation', () => ({
  invalidateSession: mockInvalidateSession,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    userBasicCache: { refresh: mockCacheRefresh },
    userSettingsCache: () => ({ bust: mockSettingsBust }),
  };
});
vi.mock('~/server/services/subscriptions.service', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    cancelSubscription: vi.fn(async () => undefined),
    reinstateSubscription: vi.fn(async () => undefined),
  };
});

const hatSync = vi.hoisted(() => ({ owner: vi.fn() }));
vi.mock('~/server/events/points/sync', async (importOriginal) => ({
  ...(await importOriginal<typeof HatSync>()),
  syncOwnerEventHats: hatSync.owner,
}));

const roster = vi.hoisted(() => ({ member: vi.fn() }));
vi.mock('~/server/events/points/roster-sync', () => ({ syncEventRosterMember: roster.member }));

const { toggleBan, AlreadyBannedError } = await import('~/server/services/user.service');
const { BanReasonCode } = await import('~/server/common/enums');

const USER_ID = 5501;
const ACTOR_ID = 5502;
const ALREADY_BANNED_AT = new Date('2026-01-02T03:04:05.000Z');

// `getUserById` reads the REPLICA; `updateUserById` writes the PRIMARY. Named separately so a
// write cannot satisfy a read assertion.
const userFindUnique = dbMock.dbRead.user.findUnique;
const userUpdate = dbMock.dbWrite.user.update;
const userFindFirst = dbMock.dbWrite.user.findFirst;
// The ban branch fans out to these and chains `.catch` on each; the canonical mock has no
// default for a write verb, so an undeclared one returns `undefined` and the fan-out throws.
const userLinkDeleteMany = dbMock.dbWrite.userLink.deleteMany;
const imageUpdateMany = dbMock.dbWrite.image.updateMany;
const commentUpdateMany = dbMock.dbWrite.comment.updateMany;
const commentV2UpdateMany = dbMock.dbWrite.commentV2.updateMany;

const call = () =>
  toggleBan({
    id: USER_ID,
    reasonCode: BanReasonCode.Other,
    userId: ACTOR_ID,
    isModerator: true,
  } as Parameters<typeof toggleBan>[0]);

beforeEach(() => {
  vi.clearAllMocks();
  userUpdate.mockResolvedValue({ id: USER_ID, paddleCustomerId: null });
  userFindFirst.mockResolvedValue(null);
  userLinkDeleteMany.mockResolvedValue({ count: 0 });
  imageUpdateMany.mockResolvedValue({ count: 0 });
  commentUpdateMany.mockResolvedValue({ count: 0 });
  commentV2UpdateMany.mockResolvedValue({ count: 0 });
});

describe('toggleBan -> user search index', () => {
  it('UNBANNING puts the account back in user search', async () => {
    // An account that is currently banned — so this call is the LIFT.
    userFindUnique.mockResolvedValue({
      bannedAt: ALREADY_BANNED_AT,
      meta: {},
      username: 'someone',
      email: null,
    });

    await call();

    expect(mockQueueUpdate).toHaveBeenCalledTimes(1);
    const [items] = mockQueueUpdate.mock.calls[0] as unknown as [
      Array<{ id: number; action: string }>
    ];
    expect(items).toEqual([{ id: USER_ID, action: 'Update' }]);
  });

  /**
   * 🔴 A REDIS BLIP MUST NOT BREAK THE UNBAN. `queueUpdate` is a Redis write placed AFTER the
   * unban has committed and BEFORE the `account-unbanned` email; unguarded, its rejection
   * propagates and the user is never told their ban was lifted, while the moderator sees a 500
   * for an action that in fact succeeded.
   */
  it('survives a failing search-index enqueue and still sends the unban email', async () => {
    userFindUnique.mockResolvedValue({
      bannedAt: ALREADY_BANNED_AT,
      meta: {},
      username: 'someone',
      email: 'someone@example.com',
    });
    mockQueueUpdate.mockRejectedValueOnce(new Error('redis is down'));

    await expect(call()).resolves.toEqual({ id: USER_ID, paddleCustomerId: null });

    expect(mockSendModerationEmail).toHaveBeenCalledTimes(1);
    expect(mockSendModerationEmail.mock.calls[0]?.[0]).toMatchObject({
      kind: 'account-unbanned',
      to: 'someone@example.com',
    });
  });

  /**
   * The other arm. Banning must NOT enqueue a refresh — a refresh would re-write the very
   * document the ban is removing. Removal goes through the content-removal path instead, which
   * is asserted here so "nothing happened" cannot pass for "the right thing happened".
   */
  it('BANNING removes instead — no refresh enqueued', async () => {
    userFindUnique.mockResolvedValue({
      bannedAt: null,
      meta: {},
      username: 'someone',
      email: null,
    });

    await call();

    expect(mockRemoveContent).toHaveBeenCalledTimes(1);
    expect(mockRemoveContent).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_ID }));
    expect(mockQueueUpdate).not.toHaveBeenCalled();
  });
});

/**
 * A ban can flag the account's comments in both tables — the ToS flag, not `hidden`; see
 * `commentsv2.service.ts` for why the flag is what removes a comment and `hidden` is not.
 */
describe('toggleBan -> removeComments', () => {
  const ban = (removeComments?: boolean) =>
    toggleBan({
      id: USER_ID,
      reasonCode: BanReasonCode.Other,
      userId: ACTOR_ID,
      isModerator: true,
      removeComments,
    } as Parameters<typeof toggleBan>[0]);

  beforeEach(() => {
    userFindUnique.mockResolvedValue({
      bannedAt: null,
      meta: {},
      username: 'someone',
      email: null,
    });
  });

  it('flags both comment tables when asked, and does not touch the author-owned hide', async () => {
    await ban(true);

    for (const updateMany of [commentUpdateMany, commentV2UpdateMany]) {
      expect(updateMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, tosViolation: false },
        data: { tosViolation: true },
      });
    }
  });

  it('leaves comments alone otherwise — it is opt-in, like removeMedia', async () => {
    await ban();

    expect(commentUpdateMany).not.toHaveBeenCalled();
    expect(commentV2UpdateMany).not.toHaveBeenCalled();
  });
});

// A banned owner's event hats stop earning at once, and earn again when the ban is lifted.
describe('toggleBan -> live event hats', () => {
  it.each([
    ['banning', null],
    ['unbanning', ALREADY_BANNED_AT],
  ])('%s brings the owner’s hats up to date after the write', async (_arm, bannedAt) => {
    userFindUnique.mockResolvedValue({ bannedAt, meta: {}, username: 'someone', email: null });
    await call();
    expect(hatSync.owner.mock.calls).toEqual([[USER_ID]]);
    expect(hatSync.owner.mock.invocationCallOrder[0]).toBeGreaterThan(
      userUpdate.mock.invocationCallOrder[0]
    );
  });

  // A banned member leaves their team's roster at once; unbanned, the sync lists them again if
  // they had opted in.
  it.each([
    ['banning', null],
    ['unbanning', ALREADY_BANNED_AT],
  ])('%s re-derives their roster entry after the write', async (_arm, bannedAt) => {
    userFindUnique.mockResolvedValue({ bannedAt, meta: {}, username: 'someone', email: null });
    await call();
    expect(roster.member.mock.calls).toEqual([[USER_ID]]);
    expect(roster.member.mock.invocationCallOrder[0]).toBeGreaterThan(
      userUpdate.mock.invocationCallOrder[0]
    );
  });
});

// The creator score re-scores an owner from `Model."updatedAt"`, which raw SQL does not bump.
describe('toggleBan -> model takedown', () => {
  it('bumps updatedAt on the models it takes down', async () => {
    userFindUnique.mockResolvedValue({
      bannedAt: null,
      meta: {},
      username: 'someone',
      email: null,
    });
    dbMock.dbRead.model.findMany.mockResolvedValue([{ id: 7701, modelVersions: [] }] as never);

    await call();

    const modelUpdates = dbMock.dbWrite.$executeRaw.mock.calls
      .map(([strings]) =>
        (strings as unknown as string[])
          .join('?')
          .replace(/--[^\n]*/g, '')
          .replace(/\s+/g, ' ')
      )
      .filter((sql) => sql.includes('UPDATE "Model" SET'));
    expect(modelUpdates).toHaveLength(1);
    expect(modelUpdates[0]).toContain('"updatedAt" = now() WHERE id IN');
  });
});

// Minor-safety bans always remove media: a moderator cannot opt out with `removeMedia: false`.
// Every other reason keeps media opt-in.
describe('toggleBan -> removeMedia', () => {
  const ban = (reasonCode: string, removeMedia?: boolean) =>
    toggleBan({
      id: USER_ID,
      reasonCode,
      userId: ACTOR_ID,
      isModerator: true,
      removeMedia,
    } as Parameters<typeof toggleBan>[0]);

  // The Moderated block's own shape, so the CSAM block in `softDeleteUser` cannot satisfy it.
  const moderatedBlocks = () =>
    imageUpdateMany.mock.calls.filter(
      ([args]) =>
        JSON.stringify(args?.where) ===
          JSON.stringify({ userId: USER_ID, ingestion: { not: 'Blocked' } }) &&
        args?.data?.blockedFor === 'moderated'
    ).length;

  beforeEach(() => {
    userFindUnique.mockResolvedValue({
      bannedAt: null,
      meta: {},
      username: 'someone',
      email: null,
    });
  });

  const minorSafetyCodes = ['SexualMinor', 'SexualMinorGenerator', 'SexualMinorTraining'];
  it.each(
    minorSafetyCodes.flatMap((code) => [false, undefined, true].map((rm) => [code, rm] as const))
  )('a %s ban blocks the media with removeMedia=%s', async (code, removeMedia) => {
    await ban(code, removeMedia);
    expect(moderatedBlocks(), `${code} ban with removeMedia=${removeMedia} left media up`).toBe(1);
  });

  it.each([
    [false, 0],
    [undefined, 0],
    [true, 1],
  ] as const)('a Harassment ban with removeMedia=%s blocks media %i time(s)', async (rm, n) => {
    await ban('Harassment', rm);
    expect(moderatedBlocks()).toBe(n);
  });

  // 🔴 Do not delete as redundant with the cases above: `softDeleteUser` applies its own CSAM
  // block right after `toggleBan`, so a Moderated block first is a wasted write over the whole
  // library. It skips it with `mediaBlockedByCaller`, which no request input can set.
  it('softDeleteUser skips the Moderated block because it CSAM-blocks the media itself', async () => {
    const { softDeleteUser } = await import('~/server/services/user.service');
    await softDeleteUser({ id: USER_ID, userId: ACTOR_ID }).catch(() => undefined);

    expect(moderatedBlocks()).toBe(0);
    expect(
      imageUpdateMany.mock.calls.some(([args]) => args?.data?.blockedFor === 'CSAM'),
      'positive control: softDeleteUser never reached its own CSAM block'
    ).toBe(true);
  });
});

describe('toggleBan -> profile links', () => {
  beforeEach(() => {
    userFindUnique.mockResolvedValue({
      bannedAt: null,
      meta: {},
      username: 'someone',
      email: null,
    });
  });

  it('deletes the profile links of a banned account', async () => {
    await call();

    expect(userLinkDeleteMany).toHaveBeenCalledWith({ where: { userId: USER_ID } });
  });

  it('keeps them when the caller asks to', async () => {
    await toggleBan({
      id: USER_ID,
      reasonCode: BanReasonCode.Chargeback,
      userId: ACTOR_ID,
      keepProfileLinks: true,
    } as Parameters<typeof toggleBan>[0]);

    expect(userUpdate).toHaveBeenCalled();
    expect(userLinkDeleteMany).not.toHaveBeenCalled();
  });
});

// The ban has committed by then: a sign-out failure must neither undo it nor skip what follows.
describe('toggleBan with a failing session store', () => {
  it('keeps a moderator ban and runs the rest of it, logging the user', async () => {
    userFindUnique.mockResolvedValue({
      bannedAt: null,
      meta: {},
      username: 'someone',
      email: 'someone@example.com',
    });
    mockInvalidateSession.mockRejectedValueOnce(new Error('session store unavailable'));

    await expect(call()).resolves.toBeDefined();

    expect(userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ bannedAt: expect.any(Date) }) })
    );
    expect(mockRemoveContent).toHaveBeenCalledTimes(1);
    expect(mockSendModerationEmail).toHaveBeenCalledTimes(1);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ban-user-invalidate-session', userId: USER_ID })
    );
  });
});

describe('toggleBan onlyBan', () => {
  const banOnly = (banActivity?: string) =>
    toggleBan({
      id: USER_ID,
      reasonCode: BanReasonCode.Chargeback,
      userId: ACTOR_ID,
      onlyBan: true,
      banActivity,
    } as Parameters<typeof toggleBan>[0]);
  const primaryFindUnique = dbMock.dbWrite.user.findUnique;
  const userUpdateMany = dbMock.dbWrite.user.updateMany;
  const modActivityCreate = dbMock.dbWrite.modActivity.create;
  const unbanned = { bannedAt: null, meta: {}, username: 'someone', email: null };

  beforeEach(() => {
    primaryFindUnique.mockResolvedValue(unbanned);
    userUpdateMany.mockResolvedValue({ count: 1 });
    dbMock.dbWrite.user.findUniqueOrThrow.mockResolvedValue({ id: USER_ID });
  });

  it('bans from the primary even while the replica still shows a lifted ban', async () => {
    userFindUnique.mockResolvedValue({ ...unbanned, bannedAt: ALREADY_BANNED_AT });

    await banOnly('chargeback:dp_1:banned');

    expect(userUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: USER_ID, bannedAt: null },
        data: expect.objectContaining({ bannedAt: expect.any(Date) }),
      })
    );
    expect(modActivityCreate).toHaveBeenCalledWith({
      data: {
        userId: ACTOR_ID,
        entityType: 'user',
        entityId: USER_ID,
        activity: 'chargeback:dp_1:banned',
      },
    });
  });

  it('refuses, and writes nothing, on an account the primary shows banned', async () => {
    primaryFindUnique.mockResolvedValue({ ...unbanned, bannedAt: ALREADY_BANNED_AT });

    await expect(banOnly()).rejects.toBeInstanceOf(AlreadyBannedError);
    expect(userUpdate).not.toHaveBeenCalled();
    expect(userUpdateMany).not.toHaveBeenCalled();
  });

  it('refuses, and records nothing, when a ban lands between the read and the write', async () => {
    userUpdateMany.mockResolvedValue({ count: 0 });

    await expect(banOnly('chargeback:dp_1:banned')).rejects.toBeInstanceOf(AlreadyBannedError);
    expect(userUpdate).not.toHaveBeenCalled();
    expect(modActivityCreate).not.toHaveBeenCalled();
    expect(mockSendModerationEmail).not.toHaveBeenCalled();
  });

  // The banned row goes back to the moderator's client; the legacy billing pointer stays server-side.
  it('returns the banned row without its subscription id', async () => {
    const row = { id: USER_ID, bannedAt: new Date(), subscriptionId: 'sub_zzfixture' };
    dbMock.dbWrite.user.findUniqueOrThrow.mockImplementation((async (args: {
      omit?: Record<string, boolean>;
    }) => Object.fromEntries(Object.entries(row).filter(([key]) => !args.omit?.[key]))) as never);

    const user = await banOnly();

    expect(user).toMatchObject({ id: USER_ID });
    expect(user).not.toHaveProperty('subscriptionId');
  });
});
