import { TRPCError } from '@trpc/server';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { ApiKeyType } from '~/shared/utils/prisma/enums';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as VersionChildrenService from '~/server/services/model-version-generation-children.service';
import type * as HotReads6 from '@civitai/db-queries/hot-reads-6';

const { mockGetVersionById, mockOwnerRow, STOP } = vi.hoisted(() => ({
  mockGetVersionById: vi.fn(),
  mockOwnerRow: vi.fn(),
  STOP: new Error('reached the coverage read'),
}));

// The controller reaches the orchestrator caller through training.service, which throws on a
// missing token at import. Nothing on this path calls it.
vi.mock('~/server/services/training.service', () => ({}));
vi.mock('~/server/services/model-version-generation-children.service', async (importOriginal) => ({
  ...(await importOriginal<typeof VersionChildrenService>()),
  getVersionByIdWithGenerationChildren: mockGetVersionById,
}));
vi.mock('~/server/services/generation/generation.service', () => ({
  getResourceData: vi.fn(async () => []),
  resolveCanGenerateForVersions: vi.fn(async () => new Map()),
}));
// The owner read behind `modelVersion.getOwner`.
vi.mock('@civitai/db-queries/hot-reads-6', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads6>()),
  getModelVersionOwnerWithCosmetics: mockOwnerRow,
  // The signed-out donation goal read checks the version exists here first: none do.
  listExistingModelVersionIds: vi.fn(async () => []),
}));
// The first read after the version is loaded and checked. Reaching it means it was served.
vi.mock('~/server/services/generation/coverage-source', () => ({
  coverageAudience: vi.fn(async () => {
    throw STOP;
  }),
  coveragePairForUser: vi.fn(() => ({})),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  getExplorationPromptsHandler,
  getModelVersionForEditHandler,
  getModelVersionHandler,
  getModelVersionOwnerHandler,
  getModelVersionRunStrategiesHandler,
  getVersionLicenseHandler,
  getVersionsByIdsHandler,
  modelVersionDonationGoalHandler,
} from '~/server/controllers/model-version.controller';

/** `modelVersion.getById` for a version of a model flagged `poi`: owner and moderators only. */

const OWNER = 7;
const VIEWERS = {
  anon: undefined,
  other: { id: 9, isModerator: false },
  owner: { id: OWNER, isModerator: false },
  moderator: { id: 1, isModerator: true },
} as const;
type ViewerKey = keyof typeof VIEWERS;

const SCOPED_KEY = {
  apiKeyId: 1,
  apiKeyType: ApiKeyType.User,
  subject: { type: 'apiKey', id: 1 },
  tokenScope: TokenScope.ModelsRead,
};

async function lookup(
  viewer: ViewerKey,
  poi: boolean,
  credential = {},
  {
    versionStatus = 'Published',
    modelStatus = 'Published',
    publishedAt = versionStatus === 'Published' ? new Date(0) : null,
  }: { versionStatus?: string; modelStatus?: string; publishedAt?: Date | null } = {}
) {
  mockGetVersionById.mockResolvedValue({
    id: 100,
    status: versionStatus,
    publishedAt,
    recommendedResources: [],
    model: { id: 1, poi, status: modelStatus, user: { id: OWNER } },
  });
  const outcome = await getModelVersionHandler({
    input: { id: 100 },
    ctx: { user: VIEWERS[viewer], features: {}, ...credential },
  } as never).then(
    () => new Error('expected to stop at the coverage read'),
    (e: unknown) => e
  );
  if (outcome instanceof TRPCError && outcome.code === 'NOT_FOUND') return 'not-found';
  // The handler wraps unexpected errors, so the stop arrives as the cause.
  if (outcome === STOP || (outcome as Error)?.cause === STOP) return 'served';
  throw outcome;
}

beforeEach(() => vi.clearAllMocks());

describe('getModelVersionHandler, flagged model', () => {
  it.each<[ViewerKey, string]>([
    ['anon', 'not-found'],
    ['other', 'not-found'],
    ['owner', 'served'],
    ['moderator', 'served'],
  ])('%s gets %s', async (viewer, expected) => {
    expect(await lookup(viewer, true)).toBe(expected);
  });

  it.each<[string, string, ViewerKey, object]>([
    ['the owner on a scoped key', 'not-found', 'owner', SCOPED_KEY],
    [
      'the owner on a full-access key',
      'served',
      'owner',
      { ...SCOPED_KEY, tokenScope: TokenScope.Full },
    ],
    // Request context leaves moderator rights only where the key keeps them (the system account).
    ['a moderator whose key kept moderator rights', 'served', 'moderator', SCOPED_KEY],
  ])('%s gets %s', async (_, expected, viewer, credential) => {
    expect(await lookup(viewer, true, credential)).toBe(expected);
  });

  it.each<ViewerKey>(['anon', 'other'])('control: unflagged model is served to %s', async (v) => {
    expect(await lookup(v, false)).toBe('served');
  });
});

describe('getModelVersionHandler, version and model status', () => {
  const FULL_KEY = { ...SCOPED_KEY, tokenScope: TokenScope.Full };
  const NOT_PUBLIC = [
    ['a draft version of a draft model', { versionStatus: 'Draft', modelStatus: 'Draft' }],
    ['a draft version of a published model', { versionStatus: 'Draft', modelStatus: 'Published' }],
    [
      'a published version of an unpublished model',
      { versionStatus: 'Published', modelStatus: 'Unpublished' },
    ],
    [
      'a version unpublished for a violation',
      { versionStatus: 'UnpublishedViolation', modelStatus: 'UnpublishedViolation' },
    ],
    ['a deleted version', { versionStatus: 'Deleted', modelStatus: 'Deleted' }],
    ['a scheduled version', { versionStatus: 'Scheduled', modelStatus: 'Published' }],
    ['a version published for a later time', { publishedAt: new Date(Date.now() + 86_400_000) }],
    [
      'an unpublished version of a published model',
      { versionStatus: 'Unpublished', modelStatus: 'Published' },
    ],
  ] as const;

  it.each(NOT_PUBLIC)(
    '%s is not found by a signed-out visitor or another user',
    async (_, statuses) => {
      expect(await lookup('anon', false, {}, statuses)).toBe('not-found');
      expect(await lookup('other', false, {}, statuses)).toBe('not-found');
    }
  );

  it.each(NOT_PUBLIC)('%s is served to its owner and to a moderator', async (_, statuses) => {
    expect(await lookup('owner', false, {}, statuses)).toBe('served');
    expect(await lookup('moderator', false, {}, statuses)).toBe('served');
  });

  it.each([
    ['a scoped key', 'not-found', SCOPED_KEY],
    ['a full-access key', 'served', FULL_KEY],
  ])('the owner of a draft on %s: %s', async (_, expected, credential) => {
    expect(await lookup('owner', false, credential, { versionStatus: 'Draft' })).toBe(expected);
  });
});

describe('getModelVersionForEditHandler, the editor read', () => {
  const edit = (credential: object) =>
    getModelVersionForEditHandler({
      input: { id: 100 },
      ctx: { user: VIEWERS.owner, features: {}, ...credential },
    } as never).then(
      () => 'resolved',
      (e: unknown) =>
        e === STOP || (e as Error)?.cause === STOP
          ? 'served'
          : e instanceof TRPCError
          ? e.code
          : String(e)
    );

  beforeEach(() => {
    mockGetVersionById.mockResolvedValue({
      id: 100,
      status: 'Draft',
      publishedAt: null,
      recommendedResources: [],
      model: { id: 1, poi: false, status: 'Draft', user: { id: OWNER } },
    });
  });

  it('serves the owner their draft on a session', async () => {
    expect(await edit({})).toBe('served');
  });

  it('serves a moderator who is not the owner', async () => {
    const outcome = await getModelVersionForEditHandler({
      input: { id: 100 },
      ctx: { user: VIEWERS.moderator, features: {} },
    } as never).then(
      () => 'resolved',
      (e: unknown) => (e === STOP || (e as Error)?.cause === STOP ? 'served' : String(e))
    );
    expect(outcome).toBe('served');
  });

  it('refuses the owner on a scoped key', async () => {
    expect(await edit(SCOPED_KEY)).toBe('UNAUTHORIZED');
  });
});

/**
 * The other public reads of one version by id, and the batch read: a version the viewer may not see
 * (by status or the poi flag) answers as one that does not exist.
 */
describe('the public sibling reads of a version', () => {
  const FULL_KEY = { ...SCOPED_KEY, tokenScope: TokenScope.Full };
  const row = (
    id: number,
    {
      versionStatus = 'Published',
      modelStatus = 'Published',
      poi = false,
      publishedAt = versionStatus === 'Published' ? new Date(0) : null,
      availability = 'Public',
    }: {
      versionStatus?: string;
      modelStatus?: string;
      poi?: boolean;
      publishedAt?: Date | null;
      availability?: string;
    } = {}
  ) => ({
    id,
    name: `v${id}`,
    baseModel: 'SD 1.5',
    status: versionStatus,
    publishedAt,
    availability,
    model: {
      availability: 'Public',
      id: 1,
      name: 'm',
      sfwName: null,
      minor: false,
      sfwOnly: false,
      userId: OWNER,
      status: modelStatus,
      poi,
    },
  });
  // Every read of these rows goes through `dbRead.modelVersion.findMany` with an id list.
  const serveRows = (rows: ReturnType<typeof row>[]) =>
    dbMock.dbRead.modelVersion.findMany.mockImplementation(async (args: any) =>
      rows.filter((r) => args.where.id.in.includes(r.id))
    );

  const HIDDEN = [
    ['a draft version', { versionStatus: 'Draft' }],
    ['a published version of a draft model', { modelStatus: 'Draft' }],
    [
      'a version unpublished for a violation',
      { versionStatus: 'UnpublishedViolation', modelStatus: 'UnpublishedViolation' },
    ],
    ['a version published for a later time', { publishedAt: new Date(Date.now() + 86_400_000) }],
    ['a version of a flagged model', { poi: true }],
  ] as const;

  const ctxFor = (viewer: ViewerKey, credential: object = {}) =>
    ({ user: VIEWERS[viewer], features: {}, ...credential } as never);

  const runStrategies = (viewer: ViewerKey, credential?: object) =>
    getModelVersionRunStrategiesHandler({ input: { id: 100 }, ctx: ctxFor(viewer, credential) });
  const prompts = (viewer: ViewerKey, credential?: object) =>
    getExplorationPromptsHandler({ input: { id: 100 }, ctx: ctxFor(viewer, credential) });
  const owner = (viewer: ViewerKey, credential?: object) =>
    getModelVersionOwnerHandler({ input: { id: 100 }, ctx: ctxFor(viewer, credential) }).then(
      (user) => (user.id === OWNER ? 'served' : user),
      (e: unknown) => (e instanceof TRPCError ? e.code : e)
    );
  const batch = async (viewer: ViewerKey, credential?: object) =>
    (
      await getVersionsByIdsHandler({ input: { ids: [100, 101] }, ctx: ctxFor(viewer, credential) })
    ).map((v) => v.id);

  const STRATEGIES = [{ partnerId: 3 }];
  const PROMPTS = [{ name: 'p', prompt: 'a cat', index: 0, modelVersionId: 100 }];

  beforeEach(() => {
    dbMock.dbRead.runStrategy.findMany.mockResolvedValue(STRATEGIES);
    dbMock.dbRead.modelVersionExploration.findMany.mockResolvedValue(PROMPTS);
    mockOwnerRow.mockResolvedValue({
      id: OWNER,
      username: 'owner',
      deletedAt: null,
      image: null,
      profilePictureId: null,
      cosmetics: [],
    });
  });

  describe.each(HIDDEN)('%s', (_, statuses) => {
    beforeEach(() => {
      serveRows([row(100, statuses), row(101)]);
    });

    it.each<ViewerKey>(['anon', 'other'])('reads as missing to %s', async (viewer) => {
      expect(await runStrategies(viewer)).toEqual([]);
      expect(await prompts(viewer)).toEqual([]);
      expect(await owner(viewer)).toBe('NOT_FOUND');
      expect(await batch(viewer)).toEqual([101]);
    });

    it.each<ViewerKey>(['owner', 'moderator'])('is served to %s', async (viewer) => {
      expect(await runStrategies(viewer)).toEqual(STRATEGIES);
      expect(await prompts(viewer)).toEqual(PROMPTS);
      expect(await owner(viewer)).toBe('served');
      expect(await batch(viewer)).toEqual([100, 101]);
    });

    it('reads as missing to its owner on a scoped key, as getById does', async () => {
      expect(await runStrategies('owner', SCOPED_KEY)).toEqual([]);
      expect(await prompts('owner', SCOPED_KEY)).toEqual([]);
      expect(await owner('owner', SCOPED_KEY)).toBe('NOT_FOUND');
      expect(await batch('owner', SCOPED_KEY)).toEqual([101]);
    });

    it('is served to its owner on a full-access key', async () => {
      expect(await runStrategies('owner', FULL_KEY)).toEqual(STRATEGIES);
      expect(await owner('owner', FULL_KEY)).toBe('served');
      expect(await batch('owner', FULL_KEY)).toEqual([100, 101]);
    });
  });

  it('control: a published version is served to a signed-out visitor', async () => {
    serveRows([row(100), row(101)]);
    expect(await runStrategies('anon')).toEqual(STRATEGIES);
    expect(await prompts('anon')).toEqual(PROMPTS);
    expect(await owner('anon')).toBe('served');
    expect(await batch('anon')).toEqual([100, 101]);
  });

  it('a version that does not exist answers the same as a hidden one', async () => {
    serveRows([row(101)]);
    expect(await runStrategies('anon')).toEqual([]);
    expect(await prompts('anon')).toEqual([]);
    expect(await owner('anon')).toBe('NOT_FOUND');
    expect(await batch('anon')).toEqual([101]);
  });
  describe('modelVersion.getLicense and modelVersion.donationGoal', () => {
    const PAST_THE_CHECK = new Error('read past the visibility check');
    const outcome = (call: Promise<unknown>) =>
      call.then(
        () => 'resolved',
        (e: unknown) =>
          e === PAST_THE_CHECK || (e as Error)?.cause === PAST_THE_CHECK
            ? 'served'
            : e instanceof TRPCError
            ? e.code
            : e
      );
    // A served license read ends at the base-model check (the row's base model has no addendum).
    const license = (viewer: ViewerKey, credential?: object) =>
      outcome(
        getVersionLicenseHandler({ input: { id: 100 }, ctx: ctxFor(viewer, credential) }).then(
          () => 'resolved'
        )
      ).then((o) => (o === 'BAD_REQUEST' ? 'served' : o));
    // A signed-in donation goal read goes on to read the version for its owner.
    const goal = (viewer: ViewerKey, credential?: object) =>
      outcome(
        modelVersionDonationGoalHandler({ input: { id: 100 }, ctx: ctxFor(viewer, credential) })
      );

    beforeEach(() => {
      dbMock.dbRead.modelVersion.findUnique.mockResolvedValue({
        id: 100,
        name: 'v1',
        baseModel: 'Flux.1 D',
        status: 'Published',
        model: { id: 1, name: 'm', status: 'Published', user: { username: 'owner' } },
      });
      dbMock.dbRead.modelVersion.findFirstOrThrow.mockRejectedValue(PAST_THE_CHECK);
      dbMock.dbWrite.modelVersion.findFirstOrThrow.mockRejectedValue(PAST_THE_CHECK);
    });

    it.each([
      ['a version of a flagged model', { poi: true }],
      ['a version published for a later time', { publishedAt: new Date(Date.now() + 86_400_000) }],
      ['a draft version', { versionStatus: 'Draft' }],
    ] as const)('%s reads as missing to another user', async (_, statuses) => {
      serveRows([row(100, statuses)]);
      expect(await license('anon')).toBe('NOT_FOUND');
      expect(await license('other')).toBe('NOT_FOUND');
      expect(await goal('anon')).toBe('NOT_FOUND');
      expect(await goal('other')).toBe('NOT_FOUND');
    });

    it('a version of a flagged model is served to its owner and a moderator', async () => {
      serveRows([row(100, { poi: true })]);
      expect(await license('owner')).toBe('served');
      expect(await license('moderator')).toBe('served');
      expect(await goal('owner')).toBe('served');
      expect(await goal('moderator')).toBe('served');
    });

    it('the owner on a scoped key reads as signed out', async () => {
      serveRows([row(100, { poi: true })]);
      expect(await license('owner', SCOPED_KEY)).toBe('NOT_FOUND');
      expect(await goal('owner', SCOPED_KEY)).toBe('NOT_FOUND');
    });

    it('control: a published version is served to another user', async () => {
      serveRows([row(100)]);
      expect(await license('other')).toBe('served');
      expect(await goal('other')).toBe('served');
    });

    it("a donation goal read on a scoped key never takes the owner's path", async () => {
      serveRows([row(100)]);
      // The owner's path reads the version for its owner; the signed-out path does not.
      await goal('owner', SCOPED_KEY).catch(() => undefined);
      expect(dbMock.dbWrite.modelVersion.findFirstOrThrow).not.toHaveBeenCalled();
      // Control: a signed-in viewer on a session does take it.
      await goal('other');
      expect(dbMock.dbWrite.modelVersion.findFirstOrThrow).toHaveBeenCalled();
    });

    it('a missing version answers the same as a hidden one', async () => {
      serveRows([]);
      expect(await license('other')).toBe('NOT_FOUND');
      expect(await goal('other')).toBe('NOT_FOUND');
    });

    describe('a Private version', () => {
      // The availability read behind the grant check, then the viewer's grants.
      const grants = (granted: boolean) => {
        serveRows([row(100, { availability: 'Private' }), row(101)]);
        dbMock.dbRead.$queryRaw.mockResolvedValue([
          {
            entityId: 100,
            userId: OWNER,
            availability: 'Private',
            publishedAt: new Date(0),
            status: 'Published',
          },
        ]);
        dbMock.dbWrite.$queryRaw.mockResolvedValue(
          granted ? [{ entityId: 100, hasAccess: true, permissions: 1, meta: {} }] : []
        );
      };

      it('reads as missing to a signed-in user with no grant, and to a signed-out visitor', async () => {
        grants(false);
        for (const viewer of ['other', 'anon'] as const) {
          expect(await runStrategies(viewer)).toEqual([]);
          expect(await prompts(viewer)).toEqual([]);
          expect(await owner(viewer)).toBe('NOT_FOUND');
          expect(await batch(viewer)).toEqual([101]);
          expect(await license(viewer)).toBe('NOT_FOUND');
          expect(await goal(viewer)).toBe('NOT_FOUND');
        }
      });

      it('is served to a signed-in user holding a grant', async () => {
        grants(true);
        expect(await runStrategies('other')).toEqual(STRATEGIES);
        expect(await prompts('other')).toEqual(PROMPTS);
        expect(await owner('other')).toBe('served');
        expect(await batch('other')).toEqual([100, 101]);
        expect(await license('other')).toBe('served');
        expect(await goal('other')).toBe('served');
      });

      it('is served to its owner without a grant', async () => {
        grants(false);
        expect(await runStrategies('owner')).toEqual(STRATEGIES);
        expect(await batch('owner')).toEqual([100, 101]);
      });
    });
  });
});
