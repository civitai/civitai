import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';

/**
 * `GET /api/v1/model-versions/mini/[id]` for an account listed in ORCHESTRATOR_LOOKUP_USER_IDS:
 * answered as an anonymous caller, so no moderator view and no model counts as its own.
 */

const h = vi.hoisted(() => ({
  user: { value: undefined as undefined | Record<string, unknown> },
  resolveCanGenerate: vi.fn(),
}));

vi.mock('~/server/services/generation/generation.service', () => ({
  resolveCanGenerateForVersions: h.resolveCanGenerate,
  getShouldChargeForResources: vi.fn(async () => ({ 77: false })),
}));
vi.mock('~/server/services/model.service', () => ({
  getFeaturedModels: vi.fn(async () => []),
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  MixedAuthEndpoint:
    (handler: (req: NextApiRequest, res: NextApiResponse, user: unknown) => unknown) =>
    (req: NextApiRequest, res: NextApiResponse) =>
      handler(req, res, h.user.value),
}));

import handler from '~/pages/api/v1/model-versions/mini/[id]';
import { EPOCH_URL, OWNER_ID, TRAINING_FILE, VERSION_ID, versionRow } from './mini-epoch-fixtures';

const SERVICE_ID = -1;
const service = { id: SERVICE_ID, isModerator: true };
const humanModerator = { id: 1, isModerator: true };
const owner = { id: OWNER_ID };

const publicRow = { ...versionRow, availability: 'Public' };
const publicFile = {
  id: 404,
  type: 'Model',
  visibility: 'Public',
  url: 'https://example.invalid/d.safetensors',
  metadata: { format: 'SafeTensor' },
  sizeKB: 131_072,
  name: 'model.safetensors',
  hashes: { SHA256: 'A'.repeat(64) },
};

type SqlFragment = { sql: string; values: unknown[] };
const isSql = (v: unknown): v is SqlFragment =>
  !!v && typeof (v as SqlFragment).sql === 'string' && Array.isArray((v as SqlFragment).values);

/**
 * The version query, with its WHERE applied to the row: the handler's visibility clause
 * `(mv.status = 'Published' OR m."userId" = <caller>)` is honoured, so a lookup that adds it
 * for a Draft it does not own gets no row, as Postgres would answer.
 */
function versionQuery(row: Record<string, unknown>) {
  return async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    const where = values.find((v) => isSql(v) && v.sql.includes('mv.id'));
    if (!isSql(where)) throw new Error('version query without its WHERE');
    if (!where.sql.includes(`mv.status = 'Published'`)) return [row];
    // The clause must compare the model's owner column; anything else is not the rule faked here.
    if (!/\(mv\.status = 'Published' OR m\."userId" = (\?|\$\d+)\)/.test(where.sql))
      throw new Error(`unexpected visibility clause: ${where.sql}`);
    const callerId = where.values[1];
    return row.status === 'Published' || row.modelUserId === callerId ? [row] : [];
  };
}

async function request(
  user: Record<string, unknown> | undefined,
  row: Record<string, unknown> = publicRow,
  file: object = publicFile
) {
  h.user.value = user;
  dbMock.dbWrite.$queryRaw.mockReset();
  dbMock.dbWrite.$queryRaw
    .mockImplementationOnce(versionQuery(row) as never)
    .mockResolvedValueOnce([structuredClone(file)]);
  const json = vi.fn().mockReturnThis();
  const res = {
    status: vi.fn().mockReturnThis(),
    json,
    setHeader: vi.fn().mockReturnThis(),
  } as unknown as NextApiResponse;
  await handler(
    {
      method: 'GET',
      query: { id: String(VERSION_ID) },
      headers: { host: 'civitai.com' },
    } as unknown as NextApiRequest,
    res
  );
  const status = (res.status as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
  const body = json.mock.calls.at(-1)?.[0] as Record<string, unknown>;
  return { status, body };
}

beforeEach(() => {
  setEnv({ ORCHESTRATOR_LOOKUP_USER_IDS: [SERVICE_ID] });
  h.resolveCanGenerate.mockReset();
  h.resolveCanGenerate.mockImplementation(
    async (versions: { id: number }[], { user }: { user: { isModerator?: boolean } }) =>
      new Map(versions.map((v) => [v.id, { canGenerate: !!user.isModerator }]))
  );
});

describe('mini/[id] for a service account', () => {
  const draft = { ...publicRow, status: 'Draft' };

  it("answers another creator's Draft as an unknown id", async () => {
    expect(await request(service, draft)).toEqual({
      status: 404,
      body: { error: 'Model not found' },
    });
  });

  it('control: a moderator session is still served that Draft', async () => {
    const { status, body } = await request(humanModerator, draft);
    expect(status).toBe(200);
    expect(body.air).toEqual(expect.any(String));
  });

  it('control: unlisted in ORCHESTRATOR_LOOKUP_USER_IDS, the same account is served it', async () => {
    setEnv({ ORCHESTRATOR_LOOKUP_USER_IDS: [] });
    expect((await request(service, draft)).status).toBe(200);
  });

  it('answers a poi model it does not own as an unknown id; a moderator is served', async () => {
    const poi = { ...publicRow, poi: true };
    expect(await request(service, poi)).toEqual({
      status: 404,
      body: { error: 'Model not found' },
    });
    expect((await request(humanModerator, poi)).status).toBe(200);
  });

  it('does not see a non-public file; a moderator does', async () => {
    const privateFile = { ...publicFile, visibility: 'Private' };
    expect((await request(service, publicRow, privateFile)).status).toBe(404);
    expect((await request(humanModerator, publicRow, privateFile)).status).toBe(200);
  });

  it('asks canGenerate (and so the tester gate) with no moderator and no id', async () => {
    const { body } = await request(service);
    expect(body.canGenerate).toBe(false);
    expect(h.resolveCanGenerate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ user: { id: undefined, isModerator: undefined } })
    );
  });

  it('control: a moderator session is asked canGenerate as a moderator', async () => {
    expect((await request(humanModerator)).body.canGenerate).toBe(true);
  });

  it("does not get a deleted model's epoch url; a moderator does", async () => {
    const deleted = { ...versionRow, modelStatus: 'Deleted' };
    expect((await request(service, deleted, TRAINING_FILE)).body.downloadUrls).toEqual([]);
    expect((await request(humanModerator, deleted, TRAINING_FILE)).body.downloadUrls).toEqual([
      EPOCH_URL,
    ]);
  });

  it('is served a Published public version as before', async () => {
    const { status, body } = await request(service);
    expect(status).toBe(200);
    expect(body.downloadUrls).toEqual(expect.arrayContaining([expect.any(String)]));
  });

  it.each([
    ['a Draft', { status: 'Draft' }],
    ['an UnpublishedViolation version', { status: 'UnpublishedViolation' }],
    ['a poi model', { poi: true }],
  ])('answers %s it owns as an unknown id', async (_label, fields) => {
    expect(await request(service, { ...publicRow, ...fields, modelUserId: SERVICE_ID })).toEqual({
      status: 404,
      body: { error: 'Model not found' },
    });
  });
});

describe('mini/[id] for an owner', () => {
  it('control: is served their own UnpublishedViolation version', async () => {
    expect((await request(owner, { ...publicRow, status: 'UnpublishedViolation' })).status).toBe(
      200
    );
  });

  it('is served their own Draft', async () => {
    const { status, body } = await request(owner, { ...publicRow, status: 'Draft' });
    expect(status).toBe(200);
    expect(body.air).toEqual(expect.any(String));
  });
});
