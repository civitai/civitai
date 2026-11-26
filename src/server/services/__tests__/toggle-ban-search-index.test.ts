import type * as ClientS3 from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { showcaseQueries } from '~/__tests__/mocks/showcase-queries';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type * as HatSync from '~/server/events/points/sync';

// The ban leg revokes recipe-runner authorizations through kyselyDb; this suite never reads them.
vi.mock('~/server/db/kyselyDb', async () => {
  const { pgliteKysely } = await import('~/__tests__/pglite-kysely');
  return {
    kyselyWrite: pgliteKysely(() => {
      throw new Error('no ledger database in this suite');
    }),
  };
});

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
  mockRefreshSession,
} = vi.hoisted(() => ({
  mockQueueUpdate: vi.fn(async () => undefined),
  mockRemoveContent: vi.fn(async () => undefined),
  mockInvalidateSession: vi.fn(async () => undefined),
  mockCacheRefresh: vi.fn(async () => undefined),
  mockSettingsBust: vi.fn(async () => undefined),
  mockSendModerationEmail: vi.fn(async (..._a: unknown[]) => undefined),
  mockRefreshSession: vi.fn(async (..._a: unknown[]) => undefined),
}));
const v3Tos = vi.hoisted(() => vi.fn(async (_userId: number) => undefined));
vi.mock('~/server/services/commentv3/moderation.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  setUserCommentsV3Tos: v3Tos,
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
  refreshSession: mockRefreshSession,
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

const { syncReviewsOfMovedPosts } = vi.hoisted(() => ({ syncReviewsOfMovedPosts: vi.fn() }));
vi.mock('~/server/services/resourceReview.visibility', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  syncReviewsOfMovedPosts,
}));

const { refreshShowcases, postServiceLoad } = vi.hoisted(() => ({
  refreshShowcases: vi.fn(async (_userId: number) => undefined),
  postServiceLoad: { fail: false },
}));
vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  // A getter so a test can make loading the export throw, as a failed lazy import would.
  get refreshShowcasesForUserModels() {
    if (postServiceLoad.fail) throw new Error('post.service failed to load');
    return refreshShowcases;
  },
}));

// The CSAM bucket: what the default archive writes when the caller passes none.
const upload = vi.hoisted(() => ({ fail: undefined as Error | undefined, done: [] as string[] }));
// Both carry `default`: the package is pre-bundled for CJS interop, so consumers resolve through it.
vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const real = await importOriginal<typeof ClientS3>();
  const objects = new Map<string, { body: Uint8Array; Metadata?: Record<string, string> }>();
  const S3Client = class {
    async send(command: unknown) {
      if (command instanceof real.PutObjectCommand) {
        if (upload.fail) throw upload.fail;
        const { Key, Body, Metadata } = command.input;
        objects.set(Key!, { body: Body as Uint8Array, Metadata });
        upload.done.push(Key!);
        return {};
      }
      if (command instanceof real.GetObjectCommand) {
        const found = objects.get(command.input.Key!)!;
        return { Metadata: found.Metadata, Body: { transformToByteArray: async () => found.body } };
      }
      return {};
    }
    destroy() {
      return undefined;
    }
  };
  const mocked = { ...real, S3Client };
  return { ...mocked, default: mocked };
});

const { toggleBan, toggleContestBan, AlreadyBannedError } = await import(
  '~/server/services/user.service'
);
const { BanReasonCode } = await import('~/server/common/enums');
const { toggleBanHandler } = await import('~/server/controllers/user.controller');

const USER_ID = 5501;
const ACTOR_ID = 5502;
const ALREADY_BANNED_AT = new Date('2026-01-02T03:04:05.000Z');

// The direction read and `updateUserById` both use the PRIMARY. Named separately so a write cannot
// satisfy a read assertion.
const userFindUnique = dbMock.dbWrite.user.findUnique;
const userUpdate = dbMock.dbWrite.user.update;
const userFindFirst = dbMock.dbWrite.user.findFirst;
// The ban branch fans out to these and chains `.catch` on each; the canonical mock has no
// default for a write verb, so an undeclared one returns `undefined` and the fan-out throws.
const userLinkDeleteMany = dbMock.dbWrite.userLink.deleteMany;
const imageUpdateMany = dbMock.dbWrite.image.updateMany;
/** Whether the CSAM report lookup names the user. */
const reportNames = (named: boolean) =>
  dbMock.dbWrite.$queryRaw.mockImplementation((async (s: readonly string[]) =>
    s.join('?').includes('"CsamReport"') ? [{ named }] : []) as never);
const oldCommentTableWrites = () =>
  dbMock.dbWrite.$executeRaw.mock.calls
    .map(([strings]) => (strings as unknown as string[]).join('?'))
    .filter((sql) => /"Comment(V2)?"/.test(sql));

const call = () =>
  toggleBan({
    id: USER_ID,
    reasonCode: BanReasonCode.Other,
    userId: ACTOR_ID,
    isModerator: true,
  } as Parameters<typeof toggleBan>[0]);

beforeEach(() => {
  vi.clearAllMocks();
  reportNames(false);
  userUpdate.mockResolvedValue({ id: USER_ID, paddleCustomerId: null });
  userFindFirst.mockResolvedValue(null);
  userLinkDeleteMany.mockResolvedValue({ count: 0 });
  imageUpdateMany.mockResolvedValue({ count: 0 });
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

    await expect(call()).resolves.toEqual({ id: USER_ID, paddleCustomerId: null, changed: true });

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

/** A ban can flag the account's comments for ToS (`setUserCommentsV3Tos`), not hide them. */
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

  it('flags the author’s comments when asked, in CommentV3 only', async () => {
    await ban(true);

    expect(v3Tos.mock.calls).toEqual([[USER_ID]]);
    expect(oldCommentTableWrites()).toEqual([]);
  });

  it('finishes the ban and logs it when flagging the CommentV3 comments fails', async () => {
    v3Tos.mockRejectedValueOnce(new Error('lock timeout'));

    await expect(ban(true)).resolves.toBeDefined();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ban-user-remove-comments', message: 'lock timeout' })
    );
  });

  it('leaves comments alone otherwise — it is opt-in, like removeMedia', async () => {
    await ban();

    expect(v3Tos).not.toHaveBeenCalled();
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

  // `blockBannedUserImages`' own shape, so the CSAM block in `softDeleteUser` cannot satisfy it.
  const moderatedBlocks = () =>
    dbMock.dbWrite.$executeRaw.mock.calls.filter(([strings, ...values]) => {
      const text = (strings as unknown as string[]).join('?');
      return (
        text.includes('UPDATE "Image"') &&
        text.includes('WHERE "userId" = ?') &&
        text.includes('AND (ingestion <>') &&
        values.includes('moderated') &&
        values.includes(USER_ID)
      );
    }).length;

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

  it("requeues the account's own models after the media block, and not without one", async () => {
    await ban('Harassment', true);
    expect(refreshShowcases).toHaveBeenCalledWith(USER_ID);

    refreshShowcases.mockClear();
    await ban('Harassment', false);
    expect(refreshShowcases).not.toHaveBeenCalled();
  });

  it('finishes the ban when the model requeue fails', async () => {
    refreshShowcases.mockRejectedValueOnce(new Error('redis down'));
    await expect(ban('Harassment', true)).resolves.toBeDefined();
    expect(moderatedBlocks()).toBe(1);
  });

  it('finishes the ban when loading the model requeue fails', async () => {
    postServiceLoad.fail = true;
    try {
      await expect(ban('Harassment', true)).resolves.toBeDefined();
    } finally {
      postServiceLoad.fail = false;
    }
    expect(moderatedBlocks()).toBe(1);
    // A throw here would abort the rest of the content removal (marker clear, avatar refresh).
    expect(loggingMock.logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ban-user-remove-content' })
    );
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
    expect(refreshShowcases).toHaveBeenCalledWith(USER_ID);
    // The block's home-block refresh (`evictHomeBlocksForImages`), looked up by this user.
    const homeBlockLookups = dbMock.dbRead.$queryRaw.mock.calls.filter(([query]) => {
      const { sql, values } = query as unknown as { sql?: string; values?: unknown[] };
      return !!sql?.includes('"CollectionItem"') && !!values?.includes(USER_ID);
    });
    expect(homeBlockLookups, 'softDeleteUser did not refresh the home blocks').toHaveLength(1);
  });
});

describe('toggleBan -> profile links', () => {
  beforeEach(() => {
    reportNames(false);
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

  const LINKS = [{ id: 1, url: 'https://example.com/me', type: 'Social' }];
  const banWithArchive = (archive: () => Promise<unknown>, extra: object = {}) =>
    toggleBan({
      id: USER_ID,
      reasonCode: BanReasonCode.Other,
      userId: ACTOR_ID,
      isModerator: true,
      archiveProfile: archive,
      ...extra,
    } as Parameters<typeof toggleBan>[0]);
  const reported = () => {
    reportNames(true);
    dbMock.dbWrite.userProfile.findUnique.mockResolvedValue(null);
    dbMock.dbWrite.userLink.findMany.mockResolvedValue(LINKS);
  };

  it('archives a reported user’s links before deleting them', async () => {
    reported();
    const archive = vi.fn(async () => undefined);

    await banWithArchive(archive);

    expect(archive).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, actorId: ACTOR_ID, links: LINKS })
    );
    expect(userLinkDeleteMany).toHaveBeenCalledWith({ where: { userId: USER_ID } });
    expect(archive.mock.invocationCallOrder[0]).toBeLessThan(
      userLinkDeleteMany.mock.invocationCallOrder[0]
    );
  });

  it('alerts the moderators when the archive fails on a ban', async () => {
    reported();
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 })
    );
    vi.stubGlobal('fetch', fetchMock);
    setEnv({ DISCORD_WEBHOOK_MOD_ALERTS: 'https://example.invalid/mod-alerts' });
    try {
      await banWithArchive(async () => {
        throw new Error('bucket down');
      });
    } finally {
      vi.unstubAllGlobals();
      setEnv({ DISCORD_WEBHOOK_MOD_ALERTS: undefined });
    }

    expect(userLinkDeleteMany).not.toHaveBeenCalled();
    const alerts = fetchMock.mock.calls.filter(
      ([url]) => String(url) === 'https://example.invalid/mod-alerts'
    );
    expect(alerts).toHaveLength(1);
    expect(JSON.stringify((alerts[0] as unknown[])[1])).toContain(String(USER_ID));
  });

  it('keeps the links and still bans when the archive fails', async () => {
    reported();
    const archive = vi.fn(async () => {
      throw new Error('bucket down');
    });

    await banWithArchive(archive);

    expect(userUpdate).toHaveBeenCalled();
    expect(userLinkDeleteMany).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ban-user-archive-profile', userId: USER_ID })
    );
  });

  it('archives without a report when the caller asks to', async () => {
    dbMock.dbWrite.userProfile.findUnique.mockResolvedValue(null);
    dbMock.dbWrite.userLink.findMany.mockResolvedValue(LINKS);
    const archive = vi.fn(async () => undefined);

    await banWithArchive(archive, { alwaysArchiveProfile: true });

    expect(archive).toHaveBeenCalledWith(expect.objectContaining({ links: LINKS }));
    expect(userLinkDeleteMany).toHaveBeenCalled();
  });

  describe('with no archive passed', () => {
    beforeEach(() => {
      setEnv({
        CSAM_UPLOAD_KEY: 'test-key',
        CSAM_UPLOAD_SECRET: 'test-secret',
        CSAM_UPLOAD_REGION: 'test-region',
        CSAM_UPLOAD_ENDPOINT: 'https://example.invalid',
        CSAM_BUCKET_NAME: 'test-bucket',
      });
      upload.fail = undefined;
      upload.done = [];
      reported();
    });

    it('writes profile.json to the CSAM bucket before deleting a reported user’s links', async () => {
      let archivedBeforeDelete: boolean | undefined;
      userLinkDeleteMany.mockImplementationOnce(async () => {
        archivedBeforeDelete = upload.done.some((k) => k.endsWith('_profile.json'));
        return { count: 1 };
      });

      await call();

      expect(userLinkDeleteMany).toHaveBeenCalledTimes(1);
      expect(archivedBeforeDelete).toBe(true);
    });

    it('keeps the links when the bucket upload fails', async () => {
      upload.fail = new Error('s3 down');

      await call();

      expect(userUpdate).toHaveBeenCalled();
      expect(userLinkDeleteMany).not.toHaveBeenCalled();
    });
  });

  it('does not archive an unreported user’s links, and deletes them', async () => {
    const archive = vi.fn(async () => undefined);

    await banWithArchive(archive);

    expect(archive).not.toHaveBeenCalled();
    expect(userLinkDeleteMany).toHaveBeenCalledWith({ where: { userId: USER_ID } });
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
    dbMock.dbRead.user.findUnique.mockResolvedValue({ ...unbanned, bannedAt: ALREADY_BANNED_AT });

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

describe('toggleBan -> reviews written from the posts its model unpublish takes down', () => {
  it('recounts the reviews of the posts the bulk unpublish took down', async () => {
    userFindUnique.mockResolvedValue({
      bannedAt: null,
      meta: {},
      username: 'someone',
      email: null,
    });
    dbMock.dbRead.model.findMany.mockResolvedValue([
      { id: 1, modelVersions: [{ id: 2 }] },
    ] as never);
    dbMock.dbWrite.$queryRaw.mockImplementation((async (strings: TemplateStringsArray) =>
      Array.isArray(strings) && strings.join('?').includes('UPDATE "Post"')
        ? [{ id: 9 }]
        : []) as never);

    await call();

    await vi.waitFor(() =>
      expect(syncReviewsOfMovedPosts).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ change: 'unpublish', postIds: [9] })
      )
    );
  });
});

describe('toggleBan -> version showcases', () => {
  it("takes a banned author's featured images out of every showcase, and back on an unban", async () => {
    userFindUnique.mockResolvedValue({
      bannedAt: null,
      meta: {},
      username: 'someone',
      email: null,
    });
    const showcaseReads = () =>
      showcaseQueries(dbMock.dbWrite.$queryRaw).map((read) => read.values);
    await call();
    expect(showcaseReads()).toEqual([[USER_ID]]);

    dbMock.dbWrite.$queryRaw.mockClear();
    userFindUnique.mockResolvedValue({
      bannedAt: ALREADY_BANNED_AT,
      meta: {},
      username: 'someone',
      email: null,
    });
    await call();
    expect(showcaseReads()).toEqual([[USER_ID]]);
  });
});

describe('toggleBan when the replica lags the primary', () => {
  const row = (bannedAt: Date | null) => ({ bannedAt, meta: {}, username: 'someone', email: null });
  const writtenBannedAt = () =>
    (userUpdate.mock.calls.at(-1)?.[0] as { data: { bannedAt: Date | null } } | undefined)?.data
      .bannedAt;

  it('bans an account the primary shows unbanned, though the replica still shows it banned', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue(row(ALREADY_BANNED_AT));
    dbMock.dbWrite.user.findUnique.mockResolvedValue(row(null));

    await call();

    expect(writtenBannedAt()).toBeInstanceOf(Date);
  });

  it('unbans an account the primary shows banned, though the replica shows it unbanned', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue(row(null));
    dbMock.dbWrite.user.findUnique.mockResolvedValue(row(ALREADY_BANNED_AT));

    await call();

    expect(writtenBannedAt()).toBeNull();
  });
});

describe('toggleContestBan when the replica lags the primary', () => {
  const contestBan = () =>
    toggleContestBan({ id: USER_ID, userId: ACTOR_ID } as Parameters<typeof toggleContestBan>[0]);
  const writtenContestBan = () =>
    (
      userUpdate.mock.calls.at(-1)?.[0] as
        | { data: { meta: { contestBanDetails?: { bannedAt: Date } } } }
        | undefined
    )?.data.meta.contestBanDetails;

  it('bans an account the primary shows unbanned, though the replica still shows it banned', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue({
      meta: { contestBanDetails: { bannedAt: ALREADY_BANNED_AT } },
    });
    dbMock.dbWrite.user.findUnique.mockResolvedValue({ meta: {} });

    await contestBan();

    expect(writtenContestBan()?.bannedAt).toBeInstanceOf(Date);
  });

  it('unbans an account the primary shows banned, though the replica shows it unbanned', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue({ meta: {} });
    dbMock.dbWrite.user.findUnique.mockResolvedValue({
      meta: { contestBanDetails: { bannedAt: ALREADY_BANNED_AT } },
    });

    await contestBan();

    expect(userUpdate).toHaveBeenCalledTimes(1);
    expect(writtenContestBan()).toBeUndefined();
  });
});

describe('toggleBan with an explicit setTo', () => {
  const row = (bannedAt: Date | null) => ({ bannedAt, meta: {}, username: 'someone', email: null });
  const banTo = (setTo?: boolean) =>
    toggleBan({
      id: USER_ID,
      reasonCode: BanReasonCode.Other,
      userId: ACTOR_ID,
      isModerator: true,
      setTo,
    } as Parameters<typeof toggleBan>[0]);
  const writtenBannedAt = () =>
    (userUpdate.mock.calls.at(-1)?.[0] as { data: { bannedAt: Date | null } } | undefined)?.data
      .bannedAt;

  beforeEach(() => {
    dbMock.dbWrite.user.findUniqueOrThrow.mockResolvedValue({ id: USER_ID, bannedAt: null });
  });

  it.each([
    ['no setTo, unbanned', undefined, null, 'ban'],
    ['no setTo, banned', undefined, ALREADY_BANNED_AT, 'unban'],
    ['setTo true, unbanned', true, null, 'ban'],
    ['setTo false, banned', false, ALREADY_BANNED_AT, 'unban'],
  ] as const)('%s: %ss', async (_, setTo, bannedAt, direction) => {
    userFindUnique.mockResolvedValue(row(bannedAt));

    const result = await banTo(setTo);

    expect(result.changed).toBe(true);
    if (direction === 'ban') expect(writtenBannedAt()).toBeInstanceOf(Date);
    else expect(writtenBannedAt()).toBeNull();
  });

  it.each([
    ['setTo true on a banned account', true, ALREADY_BANNED_AT],
    ['setTo false on an unbanned account', false, null],
  ] as const)('%s writes nothing and runs no ban side effect', async (_, setTo, bannedAt) => {
    // With an address, so a ban or unban that ran would send its email.
    userFindUnique.mockResolvedValue({ ...row(bannedAt), email: 'someone@example.com' });

    const result = await banTo(setTo);

    expect(result).toMatchObject({ changed: false });
    expect(userUpdate).not.toHaveBeenCalled();
    expect(mockRemoveContent).not.toHaveBeenCalled();
    expect(mockQueueUpdate).not.toHaveBeenCalled();
    expect(mockInvalidateSession).not.toHaveBeenCalled();
    expect(mockSendModerationEmail).not.toHaveBeenCalled();
  });
});

describe('toggleContestBan with an explicit setTo', () => {
  const banned = { meta: { contestBanDetails: { bannedAt: ALREADY_BANNED_AT } } };
  const contestBanTo = (setTo?: boolean) =>
    toggleContestBan({ id: USER_ID, userId: ACTOR_ID, setTo } as Parameters<
      typeof toggleContestBan
    >[0]);
  const writtenContestBan = () =>
    (
      userUpdate.mock.calls.at(-1)?.[0] as
        | { data: { meta: { contestBanDetails?: { bannedAt: Date } } } }
        | undefined
    )?.data.meta.contestBanDetails;

  beforeEach(() => {
    dbMock.dbWrite.user.findUniqueOrThrow.mockResolvedValue({ id: USER_ID });
  });

  it.each([
    ['no setTo, unbanned', undefined, { meta: {} }, 'ban'],
    ['no setTo, banned', undefined, banned, 'unban'],
    ['setTo true, unbanned', true, { meta: {} }, 'ban'],
    ['setTo false, banned', false, banned, 'unban'],
  ] as const)('%s: %ss', async (_, setTo, current, direction) => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(current);

    const result = await contestBanTo(setTo);

    expect(result.changed).toBe(true);
    expect(userUpdate).toHaveBeenCalledTimes(1);
    if (direction === 'ban') expect(writtenContestBan()?.bannedAt).toBeInstanceOf(Date);
    else expect(writtenContestBan()).toBeUndefined();
  });

  it.each([
    ['setTo true on a contest-banned account', true, banned],
    ['setTo false on an account without a contest ban', false, { meta: {} }],
  ] as const)('%s writes nothing', async (_, setTo, current) => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue(current);

    const result = await contestBanTo(setTo);

    expect(result).toMatchObject({ changed: false });
    expect(userUpdate).not.toHaveBeenCalled();
    expect(mockRefreshSession).not.toHaveBeenCalled();
  });
});

describe('toggleBanHandler audit', () => {
  const row = (bannedAt: Date | null) => ({ bannedAt, meta: {}, username: 'someone', email: null });
  const handle = (input: { setTo?: boolean; type?: 'contest' }) => {
    const userActivity = vi.fn(async () => undefined);
    const ctx = { user: { id: ACTOR_ID, isModerator: true }, track: { userActivity } } as never;
    const run = toggleBanHandler({
      input: { id: USER_ID, reasonCode: BanReasonCode.Other, ...input } as never,
      ctx,
    });
    return { run, userActivity };
  };

  beforeEach(() => {
    dbMock.dbWrite.user.findUniqueOrThrow.mockResolvedValue({ id: USER_ID, bannedAt: null });
  });

  it('records one Banned activity for a ban that lands', async () => {
    userFindUnique.mockResolvedValue(row(null));
    userUpdate.mockResolvedValue({ id: USER_ID, paddleCustomerId: null, bannedAt: new Date() });

    const { run, userActivity } = handle({ setTo: true });
    await run;

    expect(userActivity).toHaveBeenCalledTimes(1);
    expect(userActivity).toHaveBeenCalledWith({ type: 'Banned', targetUserId: USER_ID });
  });

  it('records one Unbanned activity for an unban that lands', async () => {
    userFindUnique.mockResolvedValue(row(ALREADY_BANNED_AT));
    userUpdate.mockResolvedValue({ id: USER_ID, paddleCustomerId: null, bannedAt: null });

    const { run, userActivity } = handle({ setTo: false });
    await run;

    expect(userActivity).toHaveBeenCalledTimes(1);
    expect(userActivity).toHaveBeenCalledWith({ type: 'Unbanned', targetUserId: USER_ID });
  });

  it.each([
    ['setTo true on a banned account', true, ALREADY_BANNED_AT],
    ['setTo false on an unbanned account', false, null],
  ] as const)('%s records no activity', async (_, setTo, bannedAt) => {
    userFindUnique.mockResolvedValue(row(bannedAt));

    const { run, userActivity } = handle({ setTo });
    await run;

    expect(userActivity).not.toHaveBeenCalled();
  });

  it('records no activity for a contest ban', async () => {
    userFindUnique.mockResolvedValue({ meta: {} });

    const { run, userActivity } = handle({ type: 'contest' });
    await expect(run).resolves.toMatchObject({ changed: true });

    expect(userActivity).not.toHaveBeenCalled();
  });
});
