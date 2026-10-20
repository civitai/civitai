import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * `GET /api/v1/model-versions/mini/[id]` for a version of a model flagged `poi`: served to its
 * owner and to moderators, and to everyone else answered exactly as an unknown id is.
 */

const { currentUser } = vi.hoisted(() => ({
  currentUser: { value: undefined as undefined | Record<string, unknown> },
}));

vi.mock('~/server/services/generation/generation.service', () => ({
  resolveCanGenerateForVersions: vi.fn(async () => new Map([[VERSION_ID, { canGenerate: true }]])),
  getShouldChargeForResources: vi.fn(async () => ({ 77: false })),
}));
vi.mock('~/server/services/model.service', () => ({
  getFeaturedModels: vi.fn(async () => []),
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  MixedAuthEndpoint:
    (handler: (req: NextApiRequest, res: NextApiResponse, user: unknown) => unknown) =>
    (req: NextApiRequest, res: NextApiResponse) =>
      handler(req, res, currentUser.value),
}));

import handler from '~/pages/api/v1/model-versions/mini/[id]';

const VERSION_ID = 555;
const OWNER_ID = 4242;

const versionRow = {
  id: VERSION_ID,
  versionName: 'v1',
  availability: 'Public',
  publishedAt: new Date('2024-01-01T00:00:00Z'),
  modelId: 77,
  modelName: 'Test Model',
  baseModel: 'SD 1.5',
  status: 'Published',
  type: 'Checkpoint',
  requireAuth: false,
  checkPermission: false,
  covered: true,
  isPromoted: false,
  generationAlias: null,
  minor: false,
  sfwOnly: false,
  usageControl: 'Download',
  modelUserId: OWNER_ID,
  poi: true,
  licensingFee: null,
  licensingFeeType: null,
  licensingFeeSettlementCurrency: null,
  isLicensingRoot: false,
  licensingSourceVersionId: null,
  sourceLicensingFeeRecipientUserId: null,
  sourceModelType: null,
  sourceBaseModel: null,
  sourceLicensingFee: null,
  sourceLicensingFeeType: null,
  sourceLicensingFeeSettlementCurrency: null,
  versionFlags: 0,
  userFlags: 0,
};

const FILE = {
  id: 101,
  type: 'Model',
  visibility: 'Public',
  url: 'https://example.invalid/a.safetensors',
  metadata: { format: 'SafeTensor', size: 'full', fp: 'fp16' },
  sizeKB: 1024,
  name: 'model.safetensors',
  hashes: { SHA256: 'A'.repeat(64) },
};

async function request(rows: object[]) {
  const mockQueryRaw = dbMock.dbWrite.$queryRaw;
  mockQueryRaw.mockReset();
  mockQueryRaw.mockResolvedValueOnce(rows).mockResolvedValueOnce([structuredClone(FILE)]);
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
  return {
    status: (res.status as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] ?? 200,
    body: json.mock.calls.at(-1)?.[0],
  };
}

beforeEach(() => {
  dbMock.dbWrite.$queryRaw.mockReset();
  currentUser.value = undefined;
});

describe('mini/[id], flagged model', () => {
  it.each([
    ['anonymous (the orchestrator calls this way)', undefined],
    ['a viewer with no id', {}],
    ['a signed-in non-owner', { id: 9001, isModerator: false }],
  ])('%s gets the unknown-id response', async (_label, user) => {
    currentUser.value = user;
    const unknown = await request([]);
    currentUser.value = user;
    const flagged = await request([versionRow]);
    expect(unknown).toEqual({ status: 404, body: { error: 'Model not found' } });
    expect(flagged).toEqual(unknown);
  });

  it.each([
    ['the owner', { id: OWNER_ID, isModerator: false }],
    ['a moderator', { id: 1, isModerator: true }],
  ])('%s is served', async (_label, user) => {
    currentUser.value = user;
    const { status, body } = await request([versionRow]);
    expect(status).toBe(200);
    expect(body.fileName).toBe(FILE.name);
  });

  it('control: an unflagged version is served anonymously', async () => {
    const { status, body } = await request([{ ...versionRow, poi: false }]);
    expect(status).toBe(200);
    expect(body.fileName).toBe(FILE.name);
  });
});
