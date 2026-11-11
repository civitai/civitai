import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

/**
 * The `moderation` block behind the real `MixedAuthEndpoint` and session layer: only a caller the
 * session layer resolves to a moderator gets it, and a shared cache must never hand it to anyone else.
 */

const h = vi.hoisted(() => ({
  bearerSession: vi.fn(),
  canGenerate: { value: true },
  publicOverride: { value: false },
}));

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: h.bearerSession }));
vi.mock('~/server/auth/session-client', () => ({
  getHubSession: vi.fn(async () => null),
  maybeRollHubCookie: vi.fn(async () => undefined),
  maybeUpgradeLegacySession: vi.fn(async () => undefined),
  sessionClient: { getSessionUserById: vi.fn(async () => null) },
}));
vi.mock('~/server/services/generation/generation.service', () => ({
  resolveCanGenerateForVersions: vi.fn(
    async () => new Map([[VERSION_ID, { canGenerate: h.canGenerate.value }]])
  ),
  getShouldChargeForResources: vi.fn(async () => ({ 77: false })),
}));
vi.mock('~/server/services/model.service', () => ({ getFeaturedModels: vi.fn(async () => []) }));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFliptVariant: vi.fn(async () => null),
  isFlipt: vi.fn(async () => false),
}));

const VERSION_ID = 555;
const OWNER_ID = 4242;
const MOD_ID = 9;
const OTHER_ID = 7001;
const SERVICE_TOKEN = 'test-service-token-0123456789abcdef';
const URL = `/api/v1/model-versions/mini/${VERSION_ID}`;

const baseRow = {
  id: VERSION_ID,
  versionName: 'v1',
  availability: 'Public',
  publishedAt: new Date('2024-01-01T00:00:00Z'),
  modelId: 77,
  modelName: 'Test Model',
  baseModel: 'SD 1.5',
  status: 'Published',
  modelStatus: 'Published',
  modelMode: null as string | null,
  modelAvailability: 'Public',
  type: 'LORA',
  requireAuth: false,
  checkPermission: false,
  covered: true,
  isPromoted: false,
  generationAlias: null,
  minor: false,
  sfwOnly: false,
  usageControl: 'Download',
  modelUserId: OWNER_ID,
  poi: false,
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
  ownerDeletedAt: null as Date | null,
  ownerBannedAt: null as Date | null,
};
type Row = typeof baseRow;

const FILE = {
  id: 404,
  type: 'Model',
  visibility: 'Public',
  url: 'https://example.invalid/d.safetensors',
  metadata: { format: 'SafeTensor' },
  sizeKB: 131_072,
  name: 'model.safetensors',
  hashes: { SHA256: 'D'.repeat(64) },
  replacedAt: null,
  pickleScanResult: 'Success',
  virusScanResult: 'Success',
};

const handler = (await import('~/pages/api/v1/model-versions/mini/[id]')).default as unknown as (
  req: NextApiRequest,
  res: NextApiResponse
) => Promise<void>;

const sessionFor = (userId: number, isModerator: boolean) => ({
  user: { id: userId, username: 'someone', bannedAt: null, isModerator },
  apiKeyId: 11,
  apiKeyType: 'User',
  subject: { type: 'apiKey', id: 11 },
  tokenScope: 0,
  buzzLimit: null,
});

const KEYS: Record<string, ReturnType<typeof sessionFor>> = {
  'mod-key': sessionFor(MOD_ID, true),
  'owner-key': sessionFor(OWNER_ID, false),
  'other-key': sessionFor(OTHER_ID, false),
};

type Served = { status: number; body?: Record<string, unknown>; headers: Record<string, string> };

async function call(authorization?: string, row: Partial<Row> = {}): Promise<Served> {
  dbMock.dbWrite.$queryRaw.mockReset();
  dbMock.dbWrite.$queryRaw
    .mockResolvedValueOnce([{ ...baseRow, ...row }])
    .mockResolvedValueOnce([structuredClone(FILE)]);
  const headers: Record<string, string> = {};
  const req = {
    method: 'GET',
    url: URL,
    query: { id: String(VERSION_ID) },
    headers: { host: 'civitai.com', ...(authorization ? { authorization } : {}) },
    cookies: {},
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as NextApiRequest;
  let status = 200;
  let body: Record<string, unknown> | undefined;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(value: Record<string, unknown>) {
      // Stands in for a handler that marks its response public, to prove the cache below can leak.
      if (h.publicOverride.value) headers['cache-control'] = 'public, s-maxage=300';
      body = value;
      return res;
    },
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return res;
    },
    getHeader: (name: string) => headers[name.toLowerCase()],
    end: () => res,
  } as unknown as NextApiResponse;
  await handler(req, res);
  return { status, body, headers };
}

/** A shared cache keyed by URL alone, ignoring Vary and credentials: the worst case for an edge. */
function sharedCache() {
  const store = new Map<string, Served>();
  return async (authorization?: string): Promise<Served & { hit: boolean }> => {
    const cached = store.get(URL);
    if (cached) return { ...structuredClone(cached), hit: true };
    const served = await call(authorization);
    const cc = served.headers['cache-control'] ?? '';
    if (/\b(public|s-maxage)\b/.test(cc) && !/\b(private|no-store)\b/.test(cc))
      store.set(URL, structuredClone(served));
    return { ...served, hit: false };
  };
}

const MODERATION_DEFAULT = {
  versionStatus: 'Published',
  modelStatus: 'Published',
  modelMode: null,
  deleted: false,
  takenDown: false,
  unpublishedViolation: false,
  versionAvailability: 'Public',
  modelAvailability: 'Public',
  poi: false,
  ownerDeleted: false,
  ownerBanned: false,
};

beforeEach(() => {
  loggingMock.logToAxiom.mockClear();
  h.canGenerate.value = true;
  h.publicOverride.value = false;
  h.bearerSession.mockReset();
  h.bearerSession.mockImplementation(async (token: string) => KEYS[token] ?? null);
  setEnv({ ORCHESTRATOR_SERVICE_TOKEN: SERVICE_TOKEN });
});

describe('mini/[id] moderation block: who gets it', () => {
  it('gives a moderator the block, private and unstored, with an absolute X-Expires an hour out', async () => {
    const before = Date.now();
    const { status, body, headers } = await call('Bearer mod-key');
    expect(status).toBe(200);
    expect(body?.moderation).toEqual(MODERATION_DEFAULT);
    expect(headers['cache-control']).toBe('private, no-store');
    expect(headers['x-expires']).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    const expires = Date.parse(headers['x-expires']);
    expect(expires - before).toBeGreaterThanOrEqual(60 * 60 * 1000);
    expect(expires - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it.each([
    ['signed out', undefined],
    ['a signed-in non-moderator', 'Bearer other-key'],
    ['the owner', 'Bearer owner-key'],
    ['the orchestrator service token, which resolves to no session', `Bearer ${SERVICE_TOKEN}`],
    ['a key the session layer does not know', 'Bearer not-a-key'],
  ])('gives %s no block and no X-Expires', async (_, authorization) => {
    const { status, body, headers } = await call(authorization);
    expect(status).toBe(200);
    expect(body).not.toHaveProperty('moderation');
    expect(headers).not.toHaveProperty('x-expires');
    expect(body?.canGenerate).toBe(true);
  });
});

describe('mini/[id] moderation block: state flags', () => {
  const deletedAt = new Date('2026-01-01T00:00:00Z');
  it.each<[string, Partial<Row>, Partial<typeof MODERATION_DEFAULT>]>([
    [
      'a deleted model',
      { modelStatus: 'Deleted', status: 'Deleted' },
      { modelStatus: 'Deleted', versionStatus: 'Deleted', deleted: true },
    ],
    [
      'a Draft version of a deleted model',
      { modelStatus: 'Deleted', status: 'Draft' },
      { modelStatus: 'Deleted', versionStatus: 'Draft', deleted: true },
    ],
    [
      'a Training version of a deleted model',
      { modelStatus: 'Deleted', status: 'Training' },
      { modelStatus: 'Deleted', versionStatus: 'Training', deleted: true },
    ],
    ['a taken-down model', { modelMode: 'TakenDown' }, { modelMode: 'TakenDown', takenDown: true }],
    [
      'a version unpublished for a violation',
      { status: 'UnpublishedViolation' },
      { versionStatus: 'UnpublishedViolation', unpublishedViolation: true },
    ],
    [
      'a model unpublished for a violation',
      { modelStatus: 'UnpublishedViolation' },
      { modelStatus: 'UnpublishedViolation', unpublishedViolation: true },
    ],
    ['a PoI model', { poi: true }, { poi: true }],
    ['an owner who deleted their account', { ownerDeletedAt: deletedAt }, { ownerDeleted: true }],
  ])('reports %s and refuses generation to every caller', async (_, row, flags) => {
    const mod = await call('Bearer mod-key', row);
    expect(mod.body?.moderation).toEqual({ ...MODERATION_DEFAULT, ...flags });
    expect(mod.body?.canGenerate).toBe(false);

    const owner = await call('Bearer owner-key', row);
    expect(owner.status).toBe(200);
    expect(owner.body).not.toHaveProperty('moderation');
    expect(owner.body?.canGenerate).toBe(false);
  });

  it('reports a banned owner without refusing generation', async () => {
    const { body } = await call('Bearer mod-key', { ownerBannedAt: deletedAt });
    expect(body?.moderation).toEqual({ ...MODERATION_DEFAULT, ownerBanned: true });
    expect(body?.canGenerate).toBe(true);
  });

  it('reports an archived model without changing generation', async () => {
    const { body } = await call('Bearer mod-key', { modelMode: 'Archived' });
    expect(body?.moderation).toEqual({ ...MODERATION_DEFAULT, modelMode: 'Archived' });
    expect(body?.canGenerate).toBe(true);
  });

  it('never turns a refused generation on', async () => {
    h.canGenerate.value = false;
    const { body } = await call('Bearer mod-key');
    expect(body?.moderation).toEqual(MODERATION_DEFAULT);
    expect(body?.canGenerate).toBe(false);
  });
});

describe('mini/[id] moderation block through a URL-keyed shared cache', () => {
  it('moderator first: the block is not stored, and the signed-out caller gets none', async () => {
    const get = sharedCache();
    const mod = await get('Bearer mod-key');
    expect(mod.body?.moderation).toEqual(MODERATION_DEFAULT);
    const anon = await get();
    expect(anon.hit).toBe(false);
    expect(anon.body).not.toHaveProperty('moderation');
  });

  it('moderator first: the orchestrator service token gets no block', async () => {
    const get = sharedCache();
    await get('Bearer mod-key');
    const svc = await get(`Bearer ${SERVICE_TOKEN}`);
    expect(svc.hit).toBe(false);
    expect(svc.body).not.toHaveProperty('moderation');
  });

  it('signed out first: the stored public body carries no block for the moderator to leak', async () => {
    const get = sharedCache();
    const anon = await get();
    expect(anon.body).not.toHaveProperty('moderation');
    const mod = await get('Bearer mod-key');
    // A URL-keyed edge answers the moderator from the public copy: no block, never someone else's.
    expect(mod.hit).toBe(true);
    expect(mod.body).not.toHaveProperty('moderation');
  });

  it('positive control: a moderator response marked public DOES leak through this cache', async () => {
    h.publicOverride.value = true;
    const get = sharedCache();
    await get('Bearer mod-key');
    const anon = await get();
    expect(anon.hit).toBe(true);
    expect(anon.body?.moderation).toEqual(MODERATION_DEFAULT);
  });
});

describe('mini/[id] moderation caller log', () => {
  const logged = () =>
    (loggingMock.logToAxiom.mock.calls as unknown as [Record<string, unknown>][])
      .map(([entry]) => entry)
      .filter((entry) => entry?.name === 'mini-moderation-caller');

  it.each([
    ['Bearer mod-key', { resolvedAs: 'api-key', principal: 'moderator', moderationIncluded: true }],
    [
      `Bearer ${SERVICE_TOKEN}`,
      { resolvedAs: 'orchestrator', principal: 'orchestrator-token', moderationIncluded: false },
    ],
    ['Bearer owner-key', { resolvedAs: 'api-key', principal: 'owner', moderationIncluded: false }],
    ['Bearer other-key', { resolvedAs: 'api-key', principal: 'other', moderationIncluded: false }],
    [
      'Bearer not-a-key',
      { resolvedAs: 'unrecognized', principal: 'other', moderationIncluded: false },
    ],
  ])('logs %s as the principal it resolves to', async (authorization, entry) => {
    await call(authorization);
    expect(logged()).toEqual([
      expect.objectContaining({ type: 'info', modelVersionId: VERSION_ID, ...entry }),
    ]);
  });

  it('logs nothing for a request with no credential', async () => {
    await call();
    expect(logged()).toEqual([]);
  });
});
