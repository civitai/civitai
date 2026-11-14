import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/** Bearer lookups are stubbed to fixed sessions. */

const h = vi.hoisted(() => ({
  bearerSession: vi.fn(),
  canGenerate: { value: true },
  hubSession: { value: null as unknown },
}));

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: h.bearerSession }));
vi.mock('~/server/auth/session-client', () => ({
  getHubSession: vi.fn(async () => h.hubSession.value),
  maybeRollHubCookie: vi.fn(async () => undefined),
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
  nsfwLevel: 1,
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
  modelDeletedAt: null as Date | null,
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

const sessionFor = (
  userId: number,
  isModerator: boolean,
  { tokenScope = TokenScope.Full, oauth = false }: { tokenScope?: number; oauth?: boolean } = {}
) => ({
  user: { id: userId, username: 'someone', bannedAt: null, isModerator },
  apiKeyId: 11,
  apiKeyType: oauth ? 'Access' : 'User',
  subject: oauth ? { type: 'oauth', id: 'client-abc' } : { type: 'apiKey', id: 11 },
  tokenScope,
  buzzLimit: null,
});

const KEYS: Record<string, ReturnType<typeof sessionFor>> = {
  'mod-key': sessionFor(MOD_ID, true),
  'mod-narrow-key': sessionFor(MOD_ID, true, { tokenScope: TokenScope.ModelsRead }),
  'mod-oauth': sessionFor(MOD_ID, true, { oauth: true }),
  'mod-oauth-user-type': { ...sessionFor(MOD_ID, true, { oauth: true }), apiKeyType: 'User' },
  'owner-key': sessionFor(OWNER_ID, false),
  'other-key': sessionFor(OTHER_ID, false),
};

type Served = { status: number; body?: Record<string, unknown>; headers: Record<string, string> };

async function call(
  authorization?: string,
  row: Partial<Row> = {},
  queryToken?: string
): Promise<Served> {
  dbMock.dbWrite.$queryRaw.mockReset();
  dbMock.dbWrite.$queryRaw
    .mockResolvedValueOnce([{ ...baseRow, ...row }])
    .mockResolvedValueOnce([structuredClone(FILE)]);
  const headers: Record<string, string> = {};
  const req = {
    method: 'GET',
    url: queryToken ? `${URL}?token=${queryToken}` : URL,
    query: { id: String(VERSION_ID), ...(queryToken ? { token: queryToken } : {}) },
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

/** A shared cache keyed by URL alone that stores anything not marked private or no-store. */
function sharedCache() {
  const store = new Map<string, Served>();
  return async (authorization?: string): Promise<Served & { hit: boolean }> => {
    const cached = store.get(URL);
    if (cached) return { ...structuredClone(cached), hit: true };
    const served = await call(authorization);
    if (!/\b(private|no-store)\b/.test(served.headers['cache-control'] ?? ''))
      store.set(URL, structuredClone(served));
    return { ...served, hit: false };
  };
}

const MODERATION_DEFAULT = {
  versionStatus: 'Published',
  modelStatus: 'Published',
  modelMode: null as string | null,
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
  h.hubSession.value = null;
  h.canGenerate.value = true;
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
    ['a moderator by an OAuth token', 'Bearer mod-oauth'],
    ['a moderator by an OAuth subject on a User-type key', 'Bearer mod-oauth-user-type'],
    // Moderator rights through a bearer credential need a full-scope personal key.
    ['a moderator by a narrow-scope personal key', 'Bearer mod-narrow-key'],
  ])('gives %s no block and no X-Expires', async (_, authorization) => {
    const { status, body, headers } = await call(authorization);
    expect(status).toBe(200);
    expect(body).not.toHaveProperty('moderation');
    expect(headers).not.toHaveProperty('x-expires');
    expect(body?.canGenerate).toBe(true);
  });
});

describe('mini/[id] moderation block: moderator credentials', () => {
  it.each([
    ['a full-scope personal key', 'Bearer mod-key'],
    ['a browser session', undefined],
  ])('gives a moderator by %s the block, private and unstored', async (_, authorization) => {
    if (!authorization) h.hubSession.value = { user: KEYS['mod-key'].user };
    const { body, headers } = await call(authorization);
    expect(body?.moderation).toEqual(MODERATION_DEFAULT);
    expect(headers['cache-control']).toBe('private, no-store');
    expect(headers).toHaveProperty('x-expires');
  });

  it('answers a moderator by an OAuth token as any credentialed non-moderator', async () => {
    const row = { modelMode: 'TakenDown' };
    const limited = await call('Bearer mod-oauth', row);
    const other = await call('Bearer other-key', row);
    expect(limited.body).not.toHaveProperty('moderation');
    expect(limited.body?.canGenerate).toBe(false);
    expect(limited.headers['cache-control']).toBe(other.headers['cache-control']);
    expect(limited.headers['cache-control']).not.toBe('private, no-store');
  });

  it('reads a moderator who is also the placeholder owner as a moderator, and still refuses', async () => {
    KEYS['owner-mod-key'] = sessionFor(OWNER_ID, true, { tokenScope: TokenScope.Full });
    const { body } = await call('Bearer owner-mod-key', { modelDeletedAt: new Date() });
    expect(body?.moderation).toMatchObject({ deleted: true });
    expect(body?.canGenerate).toBe(false);
  });

  it('reads that moderator by a narrow-scope key as the owner: no block, and still refuses', async () => {
    KEYS['owner-mod-key'] = sessionFor(OWNER_ID, true, { tokenScope: TokenScope.ModelsRead });
    const { body } = await call('Bearer owner-mod-key', { modelDeletedAt: new Date() });
    expect(body).not.toHaveProperty('moderation');
    expect(body?.canGenerate).toBe(false);
  });

  it('gives a full-scope moderator key passed as ?token= no block', async () => {
    const { body } = await call(undefined, {}, 'mod-key');
    expect(body).not.toHaveProperty('moderation');
  });
});

describe('mini/[id] deleted model with Published versions', () => {
  const at = new Date('2026-01-01T00:00:00Z');
  it.each<[string, Partial<Row>]>([
    ['status Deleted', { modelStatus: 'Deleted' }],
    ['only deletedAt set', { modelDeletedAt: at }],
    ['status Deleted and deletedAt set', { modelStatus: 'Deleted', modelDeletedAt: at }],
  ])('refuses generation to every caller when the model has %s', async (_, row) => {
    for (const authorization of [
      undefined,
      'Bearer other-key',
      'Bearer owner-key',
      `Bearer ${SERVICE_TOKEN}`,
    ]) {
      const { status, body } = await call(authorization, row);
      expect(status).toBe(200);
      expect(body?.canGenerate).toBe(false);
    }
    const mod = await call('Bearer mod-key', row);
    expect(mod.body?.canGenerate).toBe(false);
    expect(mod.body?.moderation).toMatchObject({ versionStatus: 'Published', deleted: true });
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
  it('stores the signed-out response, so the cache can serve a body to the next caller', async () => {
    const get = sharedCache();
    const first = await get();
    expect(first.headers['cache-control']).toMatch(/^public, s-maxage=\d+/);
    expect((await get()).hit).toBe(true);
  });

  it('moderator by key first: the signed-out caller gets no block', async () => {
    const get = sharedCache();
    expect((await get('Bearer mod-key')).body?.moderation).toEqual(MODERATION_DEFAULT);
    const anon = await get();
    expect(anon.hit).toBe(false);
    expect(anon.body).not.toHaveProperty('moderation');
  });

  it('moderator by a session the wrapper reads as signed out: the next caller gets no block', async () => {
    h.hubSession.value = { user: KEYS['mod-key'].user };
    const get = sharedCache();
    expect((await get()).body?.moderation).toEqual(MODERATION_DEFAULT);
    h.hubSession.value = null;
    const anon = await get();
    expect(anon.hit).toBe(false);
    expect(anon.body).not.toHaveProperty('moderation');
  });
});

describe('mini/[id] moderation caller log', () => {
  const logged = () =>
    (loggingMock.logToAxiom.mock.calls as unknown as [Record<string, unknown>][])
      .map(([entry]) => entry)
      .filter((entry) => entry?.name === 'mini-moderation-caller');

  it('logs a moderator key as a moderator that received the block', async () => {
    await call('Bearer mod-key');
    expect(logged()).toEqual([
      expect.objectContaining({ principal: 'moderator', moderationIncluded: true }),
    ]);
  });

  it('logs nothing for a request with no credential', async () => {
    await call();
    expect(logged()).toEqual([]);
  });
});
