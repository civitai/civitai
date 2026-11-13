import { TRPCError } from '@trpc/server';
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

import { getModelVersionHandler } from '~/server/controllers/model-version.controller';

/** `modelVersion.getById` for a version of a model flagged `poi`: owner and moderators only. */

const OWNER = 7;
const VIEWERS = {
  anon: undefined,
  other: { id: 9, isModerator: false },
  owner: { id: OWNER, isModerator: false },
  moderator: { id: 1, isModerator: true },
} as const;
type ViewerKey = keyof typeof VIEWERS;

async function lookup(viewer: ViewerKey, poi: boolean) {
  mockGetVersionById.mockResolvedValue({
    id: 100,
    status: 'Published',
    recommendedResources: [],
    model: { id: 1, poi, user: { id: OWNER } },
  });
  const outcome = await getModelVersionHandler({
    input: { id: 100 },
    ctx: { user: VIEWERS[viewer], features: {} },
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

  it.each<ViewerKey>(['anon', 'other'])('control: unflagged model is served to %s', async (v) => {
    expect(await lookup(v, false)).toBe('served');
  });
});
