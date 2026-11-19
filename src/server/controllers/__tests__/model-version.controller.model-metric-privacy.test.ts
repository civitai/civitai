import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { ApiKeyType } from '~/shared/utils/prisma/enums';
import type * as VersionChildrenService from '~/server/services/model-version-generation-children.service';
import type * as PaidAccessService from '~/server/services/paid-access.service';
import { inheritedMetricPrivacy } from '~/components/Resource/Forms/metric-privacy-hints';

/**
 * The version edit page renders `ModelVersionUpsertForm` from `modelVersion.getById`, and the form
 * reads the model's hide/show settings from `model.meta`. The version mock below returns only the
 * fields the handler's `select` asks for, so a select that drops the model's meta reproduces the
 * prod bug: the version form says "Follows the owner's account default" under a model-level hide.
 */

const { mockGetVersionById } = vi.hoisted(() => ({ mockGetVersionById: vi.fn() }));

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
vi.mock('~/server/services/generation/coverage-source', () => ({
  coverageAudience: vi.fn(async () => ({ next: false, member: false })),
  coveragePairForUser: vi.fn(() => ({})),
}));
vi.mock('~/server/services/paid-access.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PaidAccessService>()),
  getViewerMonetization: vi.fn(async ({ versions }: { versions: { id: number }[] }) =>
    Object.fromEntries(
      versions.map((v) => [v.id, { paidAccess: null, licensingFee: null, sale: null }])
    )
  ),
}));
vi.mock('~/server/services/creator-membership.service', () => ({
  getOwnerMetricPrivacyDefaultsForEditor: vi.fn(async () => null),
}));

import { getModelVersionHandler } from '~/server/controllers/model-version.controller';

const OWNER_ID = 7;

const versionRow = {
  id: 3369669,
  name: 'v1',
  baseModel: 'SDXL 1.0',
  status: 'Published',
  meta: {},
  recommendedResources: [],
  model: {
    id: 2973334,
    name: 'Model',
    type: 'LORA',
    status: 'Published',
    user: { id: OWNER_ID },
    meta: { hideBuzz: true, unpublishedReason: 'other', customMessage: 'mod note' },
  },
};

// Return what Prisma would: only the selected fields, nested selects applied.
function project(row: unknown, select: Record<string, unknown>): unknown {
  if (row == null || typeof row !== 'object') return row;
  const source = row as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, pick] of Object.entries(select)) {
    if (!pick || !(key in source)) continue;
    const nested =
      typeof pick === 'object' ? (pick as { select?: Record<string, unknown> }).select : undefined;
    const value = source[key];
    out[key] = nested
      ? Array.isArray(value)
        ? value.map((v) => project(v, nested))
        : project(value, nested)
      : value;
  }
  return out;
}

const load = (user: { id: number; isModerator?: boolean } | null, credential = {}) =>
  getModelVersionHandler({
    input: { id: versionRow.id },
    ctx: { user, features: {}, domain: 'blue', ...credential },
  } as never);

beforeEach(() => {
  mockGetVersionById.mockImplementation(async ({ select }) => project(versionRow, select));
});

describe('modelVersion.getById: the model-level metric privacy the version editor inherits', () => {
  it.each([
    ['owner', { id: OWNER_ID }],
    ['moderator', { id: 1, isModerator: true }],
  ])('shows the %s a model-level hide as inherited from the model', async (_, user) => {
    const { model } = await load(user);

    const inherited = inheritedMetricPrivacy({
      level: 'version',
      userSettings: {},
      modelMeta: model.meta,
      isOwner: user.id === OWNER_ID,
      ownerDefaults: model.ownerMetricPrivacyDefaults,
    });
    expect(inherited.buzz).toEqual({ hidden: true, source: 'model' });
  });

  it('serves the owner only the metric settings, not the rest of the model meta', async () => {
    const { model } = await load({ id: OWNER_ID });
    expect(model.meta).toEqual({ metricVisibility: { buzz: 'hide' } });
  });

  it('serves the owner on a scoped key no model meta', async () => {
    const scopedKey = {
      apiKeyId: 1,
      apiKeyType: ApiKeyType.User,
      subject: { type: 'apiKey', id: 1 },
      tokenScope: TokenScope.ModelsRead,
    };
    expect((await load({ id: OWNER_ID }, scopedKey)).model.meta).toBeNull();
  });

  it('serves no model meta to anyone else', async () => {
    expect((await load(null)).model.meta).toBeNull();
    expect((await load({ id: 99 })).model.meta).toBeNull();
  });
});

describe('modelVersion.getById: the version files', () => {
  const FILES = [
    { id: 1, name: 'public.safetensors', type: 'Model', visibility: 'Public' },
    { id: 2, name: 'private.safetensors', type: 'Model', visibility: 'Private' },
    { id: 3, name: 'data.zip', type: 'Training Data', visibility: 'Private' },
  ];
  const fileNames = async (user: { id: number; isModerator?: boolean } | null) => {
    mockGetVersionById.mockImplementation(async ({ select }) => ({
      ...(project(versionRow, select) as object),
      files: FILES.map((f) => ({ ...f })),
    }));
    const version = await getModelVersionHandler({
      input: { id: versionRow.id, withFiles: true },
      ctx: { user, features: {}, domain: 'blue' },
    } as never);
    return version.files.map((f: { name: string }) => f.name);
  };

  it.each([
    ['a signed-out visitor', null],
    ['another user', { id: 99 }],
  ])('gives %s the Public files and training data only', async (_, user) => {
    expect(await fileNames(user)).toEqual(['public.safetensors', 'data.zip']);
  });

  it.each([
    ['the owner', { id: OWNER_ID }],
    ['a moderator', { id: 1, isModerator: true }],
  ])('gives %s every file', async (_, user) => {
    expect(await fileNames(user)).toEqual([
      'public.safetensors',
      'private.safetensors',
      'data.zip',
    ]);
  });
});

describe('modelVersion.getById: coverage and recommended resources', () => {
  it('reads them through the one-statement loader, not as nested selects of the version', async () => {
    const generationCoverage = { covered: true, coveredNext: false };
    mockGetVersionById.mockImplementation(async ({ select }) => ({
      ...(project(versionRow, select) as object),
      generationCoverage,
      recommendedResources: [],
    }));

    const result = await load({ id: OWNER_ID });

    const { select } = mockGetVersionById.mock.lastCall![0];
    expect(select).not.toHaveProperty('generationCoverage');
    expect(select).not.toHaveProperty('recommendedResources');
    expect(result.generationCoverage).toEqual(generationCoverage);
  });
});
