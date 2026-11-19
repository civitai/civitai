import { TRPCError } from '@trpc/server';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { ApiKeyType } from '~/shared/utils/prisma/enums';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as VersionChildrenService from '~/server/services/model-version-generation-children.service';

const { mockGetVersionById, STOP } = vi.hoisted(() => ({
  mockGetVersionById: vi.fn(),
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
// The first read after the version is loaded and checked. Reaching it means it was served.
vi.mock('~/server/services/generation/coverage-source', () => ({
  coverageAudience: vi.fn(async () => {
    throw STOP;
  }),
  coveragePairForUser: vi.fn(() => ({})),
}));

import {
  getModelVersionForEditHandler,
  getModelVersionHandler,
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
  { versionStatus = 'Published', modelStatus = 'Published' } = {}
) {
  mockGetVersionById.mockResolvedValue({
    id: 100,
    status: versionStatus,
    publishedAt: versionStatus === 'Published' ? new Date(0) : null,
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

  it('refuses the owner on a scoped key', async () => {
    expect(await edit(SCOPED_KEY)).toBe('UNAUTHORIZED');
  });
});
