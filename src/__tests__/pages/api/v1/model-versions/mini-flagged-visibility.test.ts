import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * `GET /api/v1/model-versions/mini/[id]` for a version of a model flagged `poi`: served to its
 * owner and to moderators, and to everyone else answered exactly as an unknown id is.
 */

const { currentUser, mockModsOnly } = vi.hoisted(() => ({
  mockModsOnly: vi.fn<(...args: unknown[]) => Promise<Set<number>>>(async () => new Set()),
  currentUser: { value: undefined as undefined | Record<string, unknown> },
}));

vi.mock('~/server/services/generation/generation.service', () => ({
  getGateRuleState: vi.fn(async () => ({ known: true, value: [], source: 'live', ageMs: 0 })),
  getModsOnlyVersionIds: mockModsOnly,
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
  mockModsOnly.mockReset().mockResolvedValue(new Set());
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

describe('mini/[id], orchestrator markers', () => {
  it('carries poi, and asks for a permission check on a flagged version', async () => {
    currentUser.value = { id: 1, isModerator: true };
    const flagged = (await request([versionRow])).body;
    expect(flagged).toMatchObject({ poi: true, checkPermission: true });
    const control = (await request([{ ...versionRow, poi: false }])).body;
    expect(control).toMatchObject({ poi: false, checkPermission: false });
  });

  it.each([true, false])('modsOnly is the gate answer for this version (%s)', async (hidden) => {
    mockModsOnly.mockResolvedValue(new Set(hidden ? [VERSION_ID] : []));
    const { body } = await request([{ ...versionRow, poi: false }]);
    expect(body).toMatchObject({ modsOnly: hidden, checkPermission: hidden });
    expect(mockModsOnly).toHaveBeenCalledWith(
      [expect.objectContaining({ id: VERSION_ID, baseModel: versionRow.baseModel })],
      expect.objectContaining({ known: true })
    );
  });
});
