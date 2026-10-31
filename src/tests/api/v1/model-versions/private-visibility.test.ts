import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as AuthSession from '~/server/auth/get-server-auth-session';

/**
 * The public version endpoints for a Private version (the version itself, or its model): served to
 * the model's owner and to moderators, never cached; to anyone else answered exactly as a version
 * that does not exist (single lookups) or left out (batch lookups).
 */

const { session } = vi.hoisted(() => ({
  session: { user: undefined as undefined | { id?: number; isModerator?: boolean } },
}));

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_CIVITAI_LINK ??= 'https://link.example.test';
});
vi.mock('~/server/utils/endpoint-helpers', () => ({
  PublicEndpoint: (handler: unknown) => handler,
  MixedAuthEndpoint:
    (handler: (req: unknown, res: unknown, user: unknown) => unknown) =>
    (req: unknown, res: unknown) =>
      handler(req, res, session.user),
}));
vi.mock('~/server/auth/get-server-auth-session', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthSession>()),
  getServerAuthSession: vi.fn(async () => (session.user ? { user: session.user } : null)),
}));
vi.mock('~/server/services/model.service', () => ({
  getVaeFiles: vi.fn(async () => []),
  // These suites cover other behaviour; the hold has its own.
  holdShowcaseImages: async (byVersion: unknown) => byVersion,
}));
vi.mock('~/server/services/image.service', () => ({
  getImagesForModelVersion: vi.fn(async () => []),
}));
vi.mock('~/server/services/paid-access.service', () => ({
  getPaidAccess: vi.fn(async () => ({})),
  getPublicPaidAccessForModelVersions: vi.fn(async () => ({})),
  toPublicPaidAccessDto: () => null,
  bustModelSaleCache: vi.fn(),
}));
vi.mock('~/server/services/creator-program.service', () => ({
  hasValidCreatorMembershipCached: async () => false,
}));
vi.mock('~/server/services/file.service', () => ({
  getDownloadFilename: ({ file }: any) => `${file.id}.safetensors`,
}));
vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: (url: string) => url }));
vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: () => 'US',
  isRegionRestricted: () => false,
}));

import versionHandler from '~/pages/api/v1/model-versions/[id]';
import byHashHandler from '~/pages/api/v1/model-versions/by-hash/[hash]';
import byHashBatchHandler from '~/pages/api/v1/model-versions/by-hash/index';
import byHashIdsHandler from '~/pages/api/v1/model-versions/by-hash/ids';
import { isPrivateModelVersion } from '~/server/services/model-visibility.service';

const OWNER = 7;
type Availability = 'Public' | 'Private';

function version(
  id: number,
  modelId: number,
  { model, own }: { model: Availability; own: Availability }
) {
  return {
    id,
    modelId,
    name: 'v1',
    baseModel: 'SD 1.5',
    status: 'Published',
    availability: own,
    nsfwLevel: 1,
    licensingFee: null,
    files: [
      {
        id: id * 10,
        type: 'Model',
        visibility: 'Public',
        sizeKB: 1,
        modelVersionId: id,
        url: 's3://a',
        name: 'a.safetensors',
        hashes: [{ type: 'SHA256', hash: 'aaaa' }],
        metadata: { format: 'SafeTensor', size: 'pruned', fp: 'fp16' },
      },
    ],
    metrics: [],
    model: {
      name: `Model ${modelId}`,
      type: 'Checkpoint',
      nsfw: false,
      poi: false,
      mode: null,
      availability: model,
      userId: OWNER,
    },
  } as any;
}
// A Public version of a Private model, and a Private version of a Public model.
const MODEL_PRIVATE = version(100, 10, { model: 'Private', own: 'Public' });
const VERSION_PRIVATE = version(200, 20, { model: 'Public', own: 'Private' });
// Same model as VERSION_PRIVATE: only the version is Private, so this one stays visible.
const SIBLING = version(201, 20, { model: 'Public', own: 'Public' });
const CONTROL = version(300, 30, { model: 'Public', own: 'Public' });
const PRIVATE_CASES = { 'Private model': MODEL_PRIVATE, 'Private version': VERSION_PRIVATE };

async function invoke(handler: unknown, req: Record<string, unknown>) {
  const headers: Record<string, unknown> = {};
  const res: any = {
    statusCode: 200,
    setHeader(name: string, value: unknown) {
      headers[name] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  await (handler as (req: any, res: any) => Promise<void>)({ headers: {}, ...req }, res);
  return { status: res.statusCode, body: res.body, cacheControl: headers['Cache-Control'] };
}

const VIEWERS = {
  anon: undefined,
  'no id': {},
  other: { id: 9, isModerator: false },
  owner: { id: OWNER, isModerator: false },
  moderator: { id: 1, isModerator: true },
} as const;
type ViewerKey = keyof typeof VIEWERS;
const HIDDEN_FROM: ViewerKey[] = ['anon', 'no id', 'other'];
const SHOWN_TO: ViewerKey[] = ['owner', 'moderator'];
const each = <T>(cases: Record<string, T>, viewers: ViewerKey[]) =>
  Object.entries(cases).flatMap(([name, row]) => viewers.map((v) => [name, v, row] as const));

const NO_STORE = 'private, no-store';

/** What a caller could read about visibility; none of it is part of the response. */
function expectNoVisibilityFields(body: any) {
  expect(body).not.toHaveProperty('availability');
  expect(body.model).not.toHaveProperty('availability');
  expect(body.model).not.toHaveProperty('userId');
}

beforeEach(() => {
  vi.clearAllMocks();
  session.user = undefined;
  dbMock.dbRead.model.findMany.mockResolvedValue([]);
});

describe('GET /api/v1/model-versions/[id]', () => {
  const lookup = (row: unknown) => {
    dbMock.dbRead.$queryRaw.mockResolvedValueOnce(row ? [structuredClone(row)] : []);
    return invoke(versionHandler, { method: 'GET', query: { id: '100' } });
  };

  it.each(each(PRIVATE_CASES, HIDDEN_FROM))(
    '%s: %s gets the response of an unknown version',
    async (_, viewer, row) => {
      session.user = VIEWERS[viewer] as never;
      expect(await lookup(row)).toEqual(await lookup(null));
      expect(await lookup(null)).toMatchObject({ status: 404, body: { error: 'Model not found' } });
    }
  );

  it.each(each(PRIVATE_CASES, SHOWN_TO))('%s: %s is served, uncached', async (_, viewer, row) => {
    session.user = VIEWERS[viewer] as never;
    expect(await lookup(row)).toMatchObject({ status: 200, cacheControl: NO_STORE });
  });

  it('control: a Public version is served anonymously and left cacheable', async () => {
    const result = await lookup(CONTROL);
    expect(result).toMatchObject({ status: 200, cacheControl: undefined });
    expectNoVisibilityFields(result.body);
  });

  it('reads both availabilities and the owner from the database', async () => {
    await lookup(CONTROL);
    const sql = (dbMock.dbRead.$queryRaw.mock.calls[0][0] as string[]).join('?');
    expect(sql).toContain('mv."availability"');
    expect(sql).toContain("'availability', m.availability");
    expect(sql).toContain(`'userId', m."userId"`);
  });
});

/** The select every by-hash lookup must make for the visibility decision. */
const VISIBILITY_SELECT = {
  availability: true,
  model: { select: expect.objectContaining({ availability: true, userId: true }) },
};

describe('GET /api/v1/model-versions/by-hash/[hash]', () => {
  const lookup = (row: unknown) => {
    dbMock.dbRead.modelFile.findFirst.mockResolvedValueOnce(
      row ? { modelVersion: structuredClone(row) } : null
    );
    return invoke(byHashHandler, { method: 'GET', query: { hash: 'aaaa' } });
  };

  it.each(each(PRIVATE_CASES, HIDDEN_FROM))(
    '%s: %s gets the response of an unknown hash',
    async (_, viewer, row) => {
      session.user = VIEWERS[viewer] as never;
      expect(await lookup(row)).toEqual(await lookup(null));
    }
  );

  it.each(each(PRIVATE_CASES, SHOWN_TO))('%s: %s is served, uncached', async (_, viewer, row) => {
    session.user = VIEWERS[viewer] as never;
    expect(await lookup(row)).toMatchObject({ status: 200, cacheControl: NO_STORE });
  });

  it('control: a Public version is served anonymously and left cacheable', async () => {
    const result = await lookup(CONTROL);
    expect(result).toMatchObject({ status: 200, cacheControl: undefined });
    expectNoVisibilityFields(result.body);
  });

  it('selects both availabilities and the owner', async () => {
    await lookup(CONTROL);
    expect(dbMock.dbRead.modelFile.findFirst.mock.calls[0][0]).toMatchObject({
      select: { modelVersion: { select: VISIBILITY_SELECT } },
    });
  });
});

describe('POST /api/v1/model-versions/by-hash (batch)', () => {
  const lookup = async () => {
    dbMock.dbRead.modelFile.findMany.mockResolvedValueOnce(
      [MODEL_PRIVATE, VERSION_PRIVATE, SIBLING, CONTROL].map((v) => ({
        modelVersion: structuredClone(v),
      }))
    );
    const result = await invoke(byHashBatchHandler, { method: 'POST', body: ['A'.repeat(64)] });
    return { ...result, ids: (result.body as { id: number }[]).map((v) => v.id) };
  };

  it.each(HIDDEN_FROM)('%s gets only the Public versions', async (viewer) => {
    session.user = VIEWERS[viewer] as never;
    const result = await lookup();
    expect(result.ids).toEqual([SIBLING.id, CONTROL.id]);
    expect(result.cacheControl).toBeUndefined();
    for (const body of result.body as unknown[]) expectNoVisibilityFields(body);
  });

  it.each(SHOWN_TO)('%s gets all of them, uncached', async (viewer) => {
    session.user = VIEWERS[viewer] as never;
    expect(await lookup()).toMatchObject({
      ids: [MODEL_PRIVATE.id, VERSION_PRIVATE.id, SIBLING.id, CONTROL.id],
      cacheControl: NO_STORE,
    });
  });

  it('selects both availabilities and the owner', async () => {
    await lookup();
    expect(dbMock.dbRead.modelFile.findMany.mock.calls[0][0]).toMatchObject({
      select: { modelVersion: { select: VISIBILITY_SELECT } },
    });
  });
});

describe('POST /api/v1/model-versions/by-hash/ids', () => {
  const entry = (v: any, hash: string) => ({
    modelVersionId: v.id,
    modelVersion: {
      id: v.id,
      modelId: v.modelId,
      availability: v.availability,
      model: { poi: false, availability: v.model.availability, userId: OWNER },
    },
    hashes: [{ hash }],
  });
  const lookup = async () => {
    dbMock.dbRead.modelFile.findMany.mockResolvedValueOnce([
      entry(MODEL_PRIVATE, 'A'.repeat(64)),
      entry(VERSION_PRIVATE, 'B'.repeat(64)),
      entry(SIBLING, 'C'.repeat(64)),
      entry(CONTROL, 'D'.repeat(64)),
    ]);
    return invoke(byHashIdsHandler, {
      method: 'POST',
      body: ['A', 'B', 'C', 'D'].map((c) => c.repeat(64)),
    });
  };

  it.each(HIDDEN_FROM)('%s gets only the Public entries, nothing else', async (viewer) => {
    session.user = VIEWERS[viewer] as never;
    const result = await lookup();
    expect(result.body).toEqual([
      { modelVersionId: SIBLING.id, modelId: SIBLING.modelId, hash: 'C'.repeat(64) },
      { modelVersionId: CONTROL.id, modelId: CONTROL.modelId, hash: 'D'.repeat(64) },
    ]);
    expect(result.cacheControl).toBeUndefined();
  });

  it.each(SHOWN_TO)('%s gets all of them, uncached', async (viewer) => {
    session.user = VIEWERS[viewer] as never;
    const result = await lookup();
    expect((result.body as { modelVersionId: number }[]).map((e) => e.modelVersionId)).toEqual([
      MODEL_PRIVATE.id,
      VERSION_PRIVATE.id,
      SIBLING.id,
      CONTROL.id,
    ]);
    expect(result.cacheControl).toBe(NO_STORE);
  });

  it('selects both availabilities and the owner', async () => {
    await lookup();
    expect(dbMock.dbRead.modelFile.findMany.mock.calls[0][0]).toMatchObject({
      select: { modelVersion: { select: VISIBILITY_SELECT } },
    });
  });
});

describe('isPrivateModelVersion', () => {
  const row = (own: unknown, model: unknown) =>
    ({ id: 1, modelId: 1, availability: own, model: { availability: model } } as any);

  it.each([
    ['Public', 'Public', false],
    ['Unsearchable', 'Public', false],
    ['Public', 'Private', true],
    ['Private', 'Public', true],
    // A query that stops selecting availability must hide the version, not serve it.
    [undefined, 'Public', true],
    ['Public', undefined, true],
  ])('version %s, model %s -> %s', (own, model, expected) => {
    expect(isPrivateModelVersion(row(own, model))).toBe(expected);
  });
});
