import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import type * as FileService from '~/server/services/file.service';
import type { SessionUser } from '~/types/session';

// The download gate is mocked: its own rules are covered by its own tests, and what
// matters here is which of its answers this resolver serves. The maturity math runs for real.
const { gateMock } = vi.hoisted(() => ({ gateMock: vi.fn() }));
vi.mock('~/server/services/file.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FileService>()),
  getFileForModelVersion: gateMock,
}));

// eslint-disable-next-line import/first
import {
  pickDefaultResourceFile,
  resolveResourceFileForUser,
} from '~/server/services/resource-file.service';
// eslint-disable-next-line import/first
import { dbMock } from '~/__tests__/mocks/db.mock';

const versionFindFirst = dbMock.dbRead.modelVersion.findFirst;
const fileFindMany = dbMock.dbRead.modelFile.findMany;

const OWNER_ID = 900;
const VIEWER_ID = 7;

const sfwViewer: SessionUser = {
  id: VIEWER_ID,
  showNsfw: false,
  blurNsfw: true,
  browsingLevel: NsfwLevel.PG,
  onboarding: 0,
  username: 'viewer',
};
const matureViewer: SessionUser = {
  ...sfwViewer,
  showNsfw: true,
  browsingLevel: NsfwLevel.PG | NsfwLevel.PG13 | NsfwLevel.R,
};
const owner: SessionUser = { ...sfwViewer, id: OWNER_ID, username: 'creator' };
const moderator: SessionUser = { ...sfwViewer, id: 31, isModerator: true };

type FileRow = {
  id: number;
  name: string;
  type: string;
  visibility: string;
  replacedAt: Date | null;
};

let files: FileRow[];

function version(overrides: { type?: string; nsfwLevel?: number } = {}) {
  return {
    id: 100,
    name: 'v1.0',
    nsfwLevel: overrides.nsfwLevel ?? NsfwLevel.PG,
    model: {
      id: 55,
      type: overrides.type ?? 'Workflows',
      name: 'Cool Workflow',
      userId: OWNER_ID,
      user: { username: 'creator' },
    },
  };
}

function gateSuccess(overrides: Record<string, unknown> = {}) {
  return {
    status: 'success' as const,
    url: 'https://files.example/signed?token=abc',
    urlExpiresAt: new Date(),
    fileId: 10,
    sizeKB: 4,
    modelId: 55,
    modelVersionId: 100,
    nsfw: false,
    inEarlyAccess: false,
    metadata: {},
    isDownloadable: true,
    published: true,
    ...overrides,
  };
}

beforeEach(() => {
  versionFindFirst.mockReset();
  fileFindMany.mockReset();
  gateMock.mockReset();
  files = [{ id: 10, name: 'graph.json', type: 'Config', visibility: 'Public', replacedAt: null }];
  // Applies the where clause the resolver builds, so a visibility rule is tested by
  // what it lets through rather than by the shape of the query.
  fileFindMany.mockImplementation(async (args: { where: Record<string, unknown> }) =>
    files
      .filter(() => args.where.modelVersionId === 100)
      .filter((f) => !('replacedAt' in args.where) || f.replacedAt === args.where.replacedAt)
      .filter((f) => !args.where.visibility || f.visibility === args.where.visibility)
      .map(({ id, name, type }) => ({ id, name, type }))
  );
  versionFindFirst.mockResolvedValue(version());
  gateMock.mockResolvedValue(gateSuccess());
});

const resolve = (
  user: SessionUser = sfwViewer,
  extra: { fileId?: number; canViewNsfw?: boolean } = {}
) =>
  resolveResourceFileForUser({
    modelVersionId: 100,
    fileId: extra.fileId,
    user,
    canViewNsfw: extra.canViewNsfw ?? false,
  });

describe('resolveResourceFileForUser: served', () => {
  it('serves a free published Workflows version with the signed URL and meta', async () => {
    const res = await resolve();
    expect(res).toEqual({
      signedUrl: 'https://files.example/signed?token=abc',
      sizeBytes: 4 * 1024,
      meta: {
        modelId: 55,
        modelVersionId: 100,
        fileId: 10,
        fileName: 'graph.json',
        modelName: 'Cool Workflow',
        versionName: 'v1.0',
        creatorUsername: 'creator',
      },
    });
    expect(gateMock).toHaveBeenCalledWith({
      modelVersionId: 100,
      fileId: 10,
      user: sfwViewer,
      attribution: { caller: 'other', actor: 'user' },
    });
  });

  it('serves ComfyWorkflows too', async () => {
    versionFindFirst.mockResolvedValue(version({ type: 'ComfyWorkflows' }));
    await expect(resolve()).resolves.toMatchObject({ meta: { fileId: 10 } });
  });

  it("serves the owner's own published early-access version", async () => {
    gateMock.mockResolvedValue(gateSuccess({ inEarlyAccess: true }));
    await expect(resolve(owner)).resolves.toMatchObject({ meta: { fileId: 10 } });
  });
});

describe('resolveResourceFileForUser: refusals are NOT_FOUND', () => {
  it('a version that does not exist', async () => {
    versionFindFirst.mockResolvedValue(null);
    await expect(resolve()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(gateMock).not.toHaveBeenCalled();
  });

  it('a model type other than Workflows / ComfyWorkflows', async () => {
    versionFindFirst.mockResolvedValue(version({ type: 'Wildcards' }));
    await expect(resolve()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(gateMock).not.toHaveBeenCalled();
  });

  // Every field but `status` is a success, so the status check is the only refusal.
  it.each([
    ['a non-owner asking for a draft, or a deleted model', 'not-found'],
    ['early access, not bought', 'early-access'],
    ['private availability without a grant', 'no-access'],
  ])('%s (gate status %s)', async (_label, status) => {
    gateMock.mockResolvedValue({ ...gateSuccess(), status });
    await expect(resolve()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('early access a non-owner has BOUGHT (the gate serves it; this bridge does not)', async () => {
    gateMock.mockResolvedValue(gateSuccess({ inEarlyAccess: true }));
    await expect(resolve()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it("the owner's own unpublished draft (the gate serves it; this bridge does not)", async () => {
    gateMock.mockResolvedValue(gateSuccess({ published: false }));
    await expect(resolve(owner)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it("a moderator's read of a downloads-disabled version", async () => {
    gateMock.mockResolvedValue(gateSuccess({ isDownloadable: false }));
    await expect(resolve(moderator)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it("the owner's own downloads-disabled version is served", async () => {
    gateMock.mockResolvedValue(gateSuccess({ isDownloadable: false }));
    await expect(resolve(owner)).resolves.toMatchObject({ meta: { fileId: 10 } });
  });

  it('a hidden file asked for by id, for a non-owner (moderators included)', async () => {
    files.push({
      id: 11,
      name: 'secret.json',
      type: 'Config',
      visibility: 'Private',
      replacedAt: null,
    });
    for (const user of [sfwViewer, moderator]) {
      await expect(resolve(user, { fileId: 11 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    expect(gateMock).not.toHaveBeenCalled();
    // Control: the owner can read their own hidden file, so the refusal above is the
    // visibility rule and not a missing row.
    await expect(resolve(owner, { fileId: 11 })).resolves.toMatchObject({ meta: { fileId: 11 } });
  });

  it('a fileId that belongs to no file of this version', async () => {
    await expect(resolve(sfwViewer, { fileId: 12345 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(gateMock).not.toHaveBeenCalled();
  });

  it('a version with no files', async () => {
    files = [];
    await expect(resolve()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('is a TRPCError, so the router surfaces the code', async () => {
    versionFindFirst.mockResolvedValue(null);
    expect(await resolve().catch((e) => e)).toBeInstanceOf(TRPCError);
  });
});

describe('resolveResourceFileForUser: maturity runs after the download gate', () => {
  it("another user's UNPUBLISHED mature version is NOT_FOUND for a SFW viewer, not FORBIDDEN", async () => {
    versionFindFirst.mockResolvedValue(version({ nsfwLevel: NsfwLevel.R }));
    gateMock.mockResolvedValue({ status: 'not-found' });
    await expect(resolve()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it("the owner's mature draft is NOT_FOUND, not FORBIDDEN, under a SFW ceiling", async () => {
    versionFindFirst.mockResolvedValue(version({ nsfwLevel: NsfwLevel.R }));
    gateMock.mockResolvedValue(gateSuccess({ published: false }));
    await expect(resolve(owner)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a published mature version is FORBIDDEN for a SFW viewer', async () => {
    versionFindFirst.mockResolvedValue(version({ nsfwLevel: NsfwLevel.R }));
    await expect(resolve()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a mature-settings viewer on a SFW domain is FORBIDDEN', async () => {
    versionFindFirst.mockResolvedValue(version({ nsfwLevel: NsfwLevel.R }));
    await expect(resolve(matureViewer, { canViewNsfw: false })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('a version rated PG and R is FORBIDDEN for a SFW viewer (every bit must be allowed)', async () => {
    versionFindFirst.mockResolvedValue(version({ nsfwLevel: NsfwLevel.PG | NsfwLevel.R }));
    await expect(resolve()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a published mature version is served to a viewer whose ceiling allows it', async () => {
    versionFindFirst.mockResolvedValue(version({ nsfwLevel: NsfwLevel.R }));
    await expect(resolve(matureViewer, { canViewNsfw: true })).resolves.toMatchObject({
      meta: { fileId: 10 },
    });
  });
});

describe('resolveResourceFileForUser: which file', () => {
  it('without fileId, the lowest id wins a tie even when it is not the first row', async () => {
    files = [
      { id: 50, name: 'b.zip', type: 'Archive', visibility: 'Public', replacedAt: null },
      { id: 20, name: 'a.zip', type: 'Archive', visibility: 'Public', replacedAt: null },
    ];
    await resolve();
    expect(gateMock).toHaveBeenCalledWith(expect.objectContaining({ fileId: 20 }));
  });

  it('without fileId, a .json Config file beats a .zip Archive with a lower id', async () => {
    files = [
      { id: 5, name: 'bundle.zip', type: 'Archive', visibility: 'Public', replacedAt: null },
      { id: 9, name: 'graph.json', type: 'Config', visibility: 'Public', replacedAt: null },
    ];
    const res = await resolve();
    expect(res.meta).toMatchObject({ fileId: 9, fileName: 'graph.json' });
  });

  it('with fileId, that file is served even when the default would differ', async () => {
    files.push({
      id: 3,
      name: 'other.zip',
      type: 'Archive',
      visibility: 'Public',
      replacedAt: null,
    });
    gateMock.mockResolvedValue(gateSuccess({ fileId: 3 }));
    const res = await resolve(sfwViewer, { fileId: 3 });
    expect(gateMock).toHaveBeenCalledWith(expect.objectContaining({ fileId: 3 }));
    expect(res.meta).toMatchObject({ fileId: 3, fileName: 'other.zip' });
  });

  it('a replaced file is never the default', async () => {
    files = [
      { id: 1, name: 'old.json', type: 'Config', visibility: 'Public', replacedAt: new Date() },
      { id: 2, name: 'new.zip', type: 'Archive', visibility: 'Public', replacedAt: null },
    ];
    await resolve();
    expect(gateMock).toHaveBeenCalledWith(expect.objectContaining({ fileId: 2 }));
  });
});

describe('pickDefaultResourceFile', () => {
  it('ranks .json Config, then .zip Archive, then the lowest id', () => {
    const txt = { id: 1, name: 'notes.txt', type: 'Config' };
    const zip = { id: 4, name: 'w.ZIP', type: 'Archive' };
    const json = { id: 7, name: 'w.json', type: 'Config' };
    expect(pickDefaultResourceFile([txt, zip, json])).toBe(json);
    expect(pickDefaultResourceFile([txt, zip])).toBe(zip);
    expect(pickDefaultResourceFile([{ id: 8, name: 'x.png', type: 'Other' }, txt])).toBe(txt);
    // The rank needs both the type and the extension.
    const modelJson = { id: 2, name: 'x.json', type: 'Model' };
    const configZip = { id: 3, name: 'x.zip', type: 'Config' };
    expect(pickDefaultResourceFile([zip, modelJson])).toBe(zip);
    expect(pickDefaultResourceFile([json, configZip])).toBe(json);
    expect(pickDefaultResourceFile([configZip, modelJson])).toBe(modelJson);
    expect(pickDefaultResourceFile([])).toBeNull();
  });
});
