import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type * as AuthSession from '~/server/auth/get-server-auth-session';
import type * as HotReads6 from '@civitai/db-queries/hot-reads-6';

/**
 * The public version endpoints for a version of a model flagged `poi`: served to its owner and to
 * moderators; to anyone else answered exactly as a version that does not exist (single lookups)
 * or left out (batch lookups).
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
// The metric-privacy read (`prepareModelVersionResponse`) is a Kysely statement; no row is a version
// with no privacy inputs, as the Prisma `null` was.
vi.mock('@civitai/db-queries/hot-reads-6', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads6>()),
  getModelVersionPrivacyRow: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/model.service', () => ({ getVaeFiles: vi.fn(async () => []) }));
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

const OWNER = 7;
const FLAGGED_MODEL = 77;
const CONTROL_MODEL = 88;

function version(id: number, modelId: number, poi: boolean) {
  return {
    id,
    modelId,
    name: 'v1',
    baseModel: 'SD 1.5',
    status: 'Published',
    availability: 'Public',
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
      poi,
      mode: null,
      availability: 'Public',
      userId: OWNER,
    },
  } as any;
}
const FLAGGED = version(100, FLAGGED_MODEL, true);
const CONTROL = version(200, CONTROL_MODEL, false);

async function invoke(handler: unknown, req: Record<string, unknown>) {
  const res: any = {
    statusCode: 200,
    setHeader() {
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
  return { status: res.statusCode, body: res.body };
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

beforeEach(() => {
  vi.clearAllMocks();
  session.user = undefined;
  dbMock.dbRead.model.findMany.mockImplementation(async (args: any) =>
    args.where.id.in.includes(FLAGGED_MODEL) && args.where.poi === true
      ? [{ id: FLAGGED_MODEL, userId: OWNER }]
      : []
  );
});

describe('GET /api/v1/model-versions/[id]', () => {
  const lookup = (row: unknown) => {
    dbMock.dbRead.$queryRaw.mockResolvedValueOnce(row ? [structuredClone(row)] : []);
    return invoke(versionHandler, { method: 'GET', query: { id: '100' } });
  };

  it.each(HIDDEN_FROM)('%s gets the response of an unknown version', async (viewer) => {
    session.user = VIEWERS[viewer] as never;
    expect(await lookup(FLAGGED)).toEqual(await lookup(null));
    expect(await lookup(null)).toEqual({ status: 404, body: { error: 'Model not found' } });
  });

  it.each(SHOWN_TO)('%s is served', async (viewer) => {
    session.user = VIEWERS[viewer] as never;
    expect((await lookup(FLAGGED)).status).toBe(200);
  });

  it('control: an unflagged version is served anonymously', async () => {
    expect((await lookup(CONTROL)).status).toBe(200);
  });
});

describe('GET /api/v1/model-versions/by-hash/[hash]', () => {
  const lookup = (row: unknown) => {
    dbMock.dbRead.modelFile.findFirst.mockResolvedValueOnce(
      row ? { modelVersion: structuredClone(row) } : null
    );
    return invoke(byHashHandler, { method: 'GET', query: { hash: 'aaaa' } });
  };

  it.each(HIDDEN_FROM)('%s gets the response of an unknown hash', async (viewer) => {
    session.user = VIEWERS[viewer] as never;
    expect(await lookup(FLAGGED)).toEqual(await lookup(null));
  });

  it.each(SHOWN_TO)('%s is served', async (viewer) => {
    session.user = VIEWERS[viewer] as never;
    expect((await lookup(FLAGGED)).status).toBe(200);
  });

  it('control: an unflagged version is served anonymously', async () => {
    expect((await lookup(CONTROL)).status).toBe(200);
  });
});

describe('POST /api/v1/model-versions/by-hash (batch)', () => {
  const lookup = async () => {
    dbMock.dbRead.modelFile.findMany.mockResolvedValueOnce([
      { modelVersion: structuredClone(FLAGGED) },
      { modelVersion: structuredClone(CONTROL) },
    ]);
    const { body } = await invoke(byHashBatchHandler, { method: 'POST', body: ['A'.repeat(64)] });
    return (body as { id: number }[]).map((v) => v.id);
  };

  it.each(HIDDEN_FROM)('%s gets only the unflagged version', async (viewer) => {
    session.user = VIEWERS[viewer] as never;
    expect(await lookup()).toEqual([CONTROL.id]);
  });

  it.each(SHOWN_TO)('%s gets both', async (viewer) => {
    session.user = VIEWERS[viewer] as never;
    expect(await lookup()).toEqual([FLAGGED.id, CONTROL.id]);
  });
});

describe('POST /api/v1/model-versions/by-hash/ids', () => {
  const lookup = async () => {
    dbMock.dbRead.modelFile.findMany.mockResolvedValueOnce([
      {
        modelVersionId: FLAGGED.id,
        modelVersion: {
          id: FLAGGED.id,
          modelId: FLAGGED_MODEL,
          availability: 'Public',
          model: { poi: true, availability: 'Public', userId: OWNER },
        },
        hashes: [{ hash: 'A'.repeat(64) }],
      },
      {
        modelVersionId: CONTROL.id,
        modelVersion: {
          id: CONTROL.id,
          modelId: CONTROL_MODEL,
          availability: 'Public',
          model: { poi: false, availability: 'Public', userId: OWNER },
        },
        hashes: [{ hash: 'B'.repeat(64) }],
      },
    ]);
    const { body } = await invoke(byHashIdsHandler, {
      method: 'POST',
      body: ['A'.repeat(64), 'B'.repeat(64)],
    });
    return body;
  };

  it.each(HIDDEN_FROM)('%s gets only the unflagged entry, nothing else', async (viewer) => {
    session.user = VIEWERS[viewer] as never;
    expect(await lookup()).toEqual([
      { modelVersionId: CONTROL.id, modelId: CONTROL_MODEL, hash: 'B'.repeat(64) },
    ]);
  });

  it.each(SHOWN_TO)('%s gets both', async (viewer) => {
    session.user = VIEWERS[viewer] as never;
    expect(((await lookup()) as unknown[]).length).toBe(2);
  });
});

describe('GET /api/v1/model-versions/[id] for an account in ORCHESTRATOR_LOOKUP_USER_IDS', () => {
  // Positive, so the owner check (ids above 0 only) can see it as owner.
  const SERVICE_ID = 9001;
  const service = { id: SERVICE_ID, isModerator: true };
  const moderator = VIEWERS.moderator;

  type SqlFragment = { sql: string; values: unknown[] };
  const isSql = (v: unknown): v is SqlFragment =>
    !!v && typeof (v as SqlFragment).sql === 'string' && Array.isArray((v as SqlFragment).values);

  /** The version query, with its status filter applied to the row as Postgres would. */
  const lookup = (row: { id: number; status: string }) => {
    dbMock.dbRead.$queryRaw.mockImplementationOnce((async (
      _strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      const filter = values.find((v) => isSql(v) && v.sql.includes('mv.status'));
      if (!isSql(filter) || filter.sql === '') return [structuredClone(row)];
      if (!/^AND mv\.status = (\?|\$\d+)::"ModelStatus"$/.test(filter.sql.trim()))
        throw new Error(`unexpected status filter: ${filter.sql}`);
      return filter.values[0] === row.status ? [structuredClone(row)] : [];
    }) as never);
    return invoke(versionHandler, { method: 'GET', query: { id: String(row.id) } });
  };
  const notFound = { status: 404, body: { error: 'Model not found' } };

  beforeEach(() => setEnv({ ORCHESTRATOR_LOOKUP_USER_IDS: [SERVICE_ID] }));

  it('answers an Unpublished version as an unknown id; a moderator is served', async () => {
    const unpublished = { ...CONTROL, status: 'Unpublished' };
    session.user = service as never;
    expect(await lookup(unpublished)).toEqual(notFound);
    session.user = moderator as never;
    expect((await lookup(unpublished)).status).toBe(200);
  });

  it('answers a poi model as an unknown id; a moderator is served', async () => {
    session.user = service as never;
    expect(await lookup(FLAGGED)).toEqual(notFound);
    session.user = moderator as never;
    expect((await lookup(FLAGGED)).status).toBe(200);
  });

  it('answers a poi model it owns as an unknown id', async () => {
    dbMock.dbRead.model.findMany.mockResolvedValue([{ id: FLAGGED_MODEL, userId: SERVICE_ID }]);
    session.user = service as never;
    expect(await lookup({ ...FLAGGED, model: { ...FLAGGED.model, userId: SERVICE_ID } })).toEqual(
      notFound
    );
  });

  it('control: unlisted, the same account is served an Unpublished version', async () => {
    setEnv({ ORCHESTRATOR_LOOKUP_USER_IDS: [] });
    session.user = service as never;
    expect((await lookup({ ...CONTROL, status: 'Unpublished' })).status).toBe(200);
  });

  it('is served a Published public version as before', async () => {
    session.user = service as never;
    expect((await lookup(CONTROL)).status).toBe(200);
  });
});
