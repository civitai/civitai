import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import type { SessionUser } from '~/types/session';

// The service under test resolves a wildcard pack's gated signed URL for the
// CURRENT USER. We mock the two IO seams — the DB reads (`dbRead`) and the
// authoritative download gate (`getFileForModelVersion`) — and let the REAL
// maturity math (getServerBrowsingLevel + Flags + allowMatureContentForCeiling)
// run, since that's the security-relevant logic.

const { modelVersionFindFirst, modelFileFindUnique, getFileForModelVersionMock } = vi.hoisted(
  () => ({
    modelVersionFindFirst: vi.fn(),
    modelFileFindUnique: vi.fn(),
    getFileForModelVersionMock: vi.fn(),
  })
);
vi.mock('~/server/db/client', () => ({
  dbRead: {
    modelVersion: { findFirst: modelVersionFindFirst },
    modelFile: { findUnique: modelFileFindUnique },
  },
  dbWrite: {},
}));

vi.mock('~/server/services/file.service', () => ({
  getFileForModelVersion: getFileForModelVersionMock,
}));

// eslint-disable-next-line import/first
import { resolveWildcardPackForUser } from '~/server/services/wildcard-pack.service';

const sfwUser: SessionUser = {
  id: 7,
  showNsfw: false,
  blurNsfw: true,
  browsingLevel: NsfwLevel.PG,
  onboarding: 0,
  username: 'viewer',
};

const matureUser: SessionUser = {
  ...sfwUser,
  showNsfw: true,
  browsingLevel: NsfwLevel.PG | NsfwLevel.PG13 | NsfwLevel.R,
};

function wildcardVersion(overrides: Partial<{ nsfwLevel: number }> = {}) {
  return {
    id: 100,
    name: 'v1.0',
    nsfwLevel: overrides.nsfwLevel ?? NsfwLevel.PG,
    model: {
      id: 55,
      type: 'Wildcards',
      name: 'Cool Wildcards',
      user: { username: 'creator' },
    },
  };
}

const successGate = {
  status: 'success' as const,
  url: 'https://civitai-modelfiles.example/signed?token=abc',
  fileId: 999,
  modelId: 55,
  modelVersionId: 100,
  nsfw: false,
  inEarlyAccess: false,
  metadata: {},
  isDownloadable: true,
};

beforeEach(() => {
  modelVersionFindFirst.mockReset();
  modelFileFindUnique.mockReset();
  getFileForModelVersionMock.mockReset();
  modelFileFindUnique.mockResolvedValue({ sizeKB: 500 });
});

describe('resolveWildcardPackForUser — type gate', () => {
  it('throws NOT_FOUND when the version does not exist', async () => {
    modelVersionFindFirst.mockResolvedValue(null);
    await expect(
      resolveWildcardPackForUser({ modelVersionId: 100, user: sfwUser, canViewNsfw: false })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(getFileForModelVersionMock).not.toHaveBeenCalled();
  });

  it('throws NOT_FOUND when the model is not a Wildcards type (no probing)', async () => {
    modelVersionFindFirst.mockResolvedValue({
      ...wildcardVersion(),
      model: { ...wildcardVersion().model, type: 'Checkpoint' },
    });
    await expect(
      resolveWildcardPackForUser({ modelVersionId: 100, user: sfwUser, canViewNsfw: false })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(getFileForModelVersionMock).not.toHaveBeenCalled();
  });
});

describe('resolveWildcardPackForUser — download gate (getFileForModelVersion is authoritative)', () => {
  it.each([
    'not-found',
    'unauthorized',
    'archived',
    'downloads-disabled',
    'early-access',
    'resolve-failed',
    'error',
  ])('collapses gate status %s to NOT_FOUND (no probing)', async (status) => {
    modelVersionFindFirst.mockResolvedValue(wildcardVersion());
    getFileForModelVersionMock.mockResolvedValue({ status });
    await expect(
      resolveWildcardPackForUser({ modelVersionId: 100, user: sfwUser, canViewNsfw: false })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('passes the CURRENT USER to the gate (requireAuth / entitlements enforced for that user)', async () => {
    modelVersionFindFirst.mockResolvedValue(wildcardVersion());
    getFileForModelVersionMock.mockResolvedValue(successGate);
    await resolveWildcardPackForUser({ modelVersionId: 100, user: sfwUser, canViewNsfw: false });
    expect(getFileForModelVersionMock).toHaveBeenCalledWith({ modelVersionId: 100, user: sfwUser });
  });
});

describe('resolveWildcardPackForUser — maturity ceiling', () => {
  it('FORBIDs a mature pack for an under-ceiling (SFW) user', async () => {
    modelVersionFindFirst.mockResolvedValue(wildcardVersion({ nsfwLevel: NsfwLevel.R }));
    getFileForModelVersionMock.mockResolvedValue(successGate);
    await expect(
      resolveWildcardPackForUser({ modelVersionId: 100, user: sfwUser, canViewNsfw: false })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('serves a mature pack to a user whose ceiling allows it (sfwOnly:false)', async () => {
    modelVersionFindFirst.mockResolvedValue(wildcardVersion({ nsfwLevel: NsfwLevel.R }));
    getFileForModelVersionMock.mockResolvedValue(successGate);
    const res = await resolveWildcardPackForUser({
      modelVersionId: 100,
      user: matureUser,
      canViewNsfw: true,
    });
    expect(res.maturity.sfwOnly).toBe(false);
    expect(res.signedUrl).toBe(successGate.url);
  });

  it('serves a SFW (PG) pack to a SFW user with sfwOnly:true + the SFW ceiling', async () => {
    modelVersionFindFirst.mockResolvedValue(wildcardVersion({ nsfwLevel: NsfwLevel.PG }));
    getFileForModelVersionMock.mockResolvedValue(successGate);
    const res = await resolveWildcardPackForUser({
      modelVersionId: 100,
      user: sfwUser,
      canViewNsfw: false,
    });
    expect(res.maturity).toEqual({ browsingLevel: sfwBrowsingLevelsFlag, sfwOnly: true });
  });
});

describe('resolveWildcardPackForUser — success shape', () => {
  it('returns the resolved URL, sizeBytes, meta, and maturity', async () => {
    modelVersionFindFirst.mockResolvedValue(wildcardVersion());
    getFileForModelVersionMock.mockResolvedValue(successGate);
    modelFileFindUnique.mockResolvedValue({ sizeKB: 500 });

    const res = await resolveWildcardPackForUser({
      modelVersionId: 100,
      user: sfwUser,
      canViewNsfw: false,
    });

    expect(res.signedUrl).toBe(successGate.url);
    expect(res.sizeBytes).toBe(500 * 1024);
    expect(res.meta).toEqual({
      modelId: 55,
      modelVersionId: 100,
      modelName: 'Cool Wildcards',
      versionName: 'v1.0',
      creatorUsername: 'creator',
    });
    // sizeBytes read from the EXACT gate-resolved fileId (no drift).
    expect(modelFileFindUnique).toHaveBeenCalledWith({
      where: { id: successGate.fileId },
      select: { sizeKB: true },
    });
  });

  it('is a TRPCError instance on refusal (so the router surfaces the right code)', async () => {
    modelVersionFindFirst.mockResolvedValue(null);
    const err = await resolveWildcardPackForUser({
      modelVersionId: 100,
      user: sfwUser,
      canViewNsfw: false,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
  });
});
