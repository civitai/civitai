import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type * as LinkStore from '~/server/services/download-link/download-link.store';
import type * as GenerationFetch from '~/server/services/download-link/generation-fetch.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * Mini's `downloadLink` (`?downloadLink=1`): who is handed one, and that everyone else, and every
 * case where the mint is off or fails, gets the response they would without it. The mint runs for
 * real; only its store and access check are faked.
 */

const h = vi.hoisted(() => ({
  bearerSession: vi.fn(),
  canGenerate: { value: true },
  hubSession: { value: null as unknown },
  flagModes: new Set<string>(),
  scopeGate: { value: null as string | null },
  notUpToDate: { value: false },
  check: vi.fn(),
  findReusableLink: vi.fn(),
  createLink: vi.fn(),
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFliptVariant: vi.fn(async (flag: string) =>
    flag === 'download-scope-gate' ? h.scopeGate.value : null
  ),
  isFlipt: vi.fn(
    async (flag: string, _entityId?: string, context?: Record<string, string>) =>
      flag === 'download-links-enabled' && h.flagModes.has(context?.mode ?? '')
  ),
}));
vi.mock('~/server/db/db-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkNotUpToDate: async () => h.notUpToDate.value,
}));
vi.mock('~/server/services/download-link/generation-fetch.service', async (importOriginal) => ({
  ...(await importOriginal<typeof GenerationFetch>()),
  checkGenerationFetch: h.check,
}));
vi.mock('~/server/services/download-link/download-link.store', async (importOriginal) => ({
  ...(await importOriginal<typeof LinkStore>()),
  findReusableLink: h.findReusableLink,
  createLink: h.createLink,
  takeMintBudget: async () => ({ allowed: true, granted: 1, retryAfterSeconds: 1 }),
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

const VERSION_ID = 555;
const OWNER_ID = 4242;
const MOD_ID = 9;
const OTHER_ID = 7001;
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
  apiKeyId: number,
  tokenScope: number = TokenScope.Full
) => ({
  user: { id: userId, username: 'someone', bannedAt: null, isModerator },
  apiKeyId,
  apiKeyType: 'User',
  subject: { type: 'apiKey', id: apiKeyId },
  tokenScope,
  buzzLimit: null,
});

const ORCH_KEY_ID = 31;
const KEYS: Record<string, ReturnType<typeof sessionFor>> = {
  'orch-key': sessionFor(MOD_ID, true, ORCH_KEY_ID),
  'orch-plain-key': sessionFor(OTHER_ID, false, 32),
  // Allowlisted, but its scope covers neither of mini's.
  'orch-unscoped-key': sessionFor(OTHER_ID, false, 33, TokenScope.UserRead),
  'mod-key': sessionFor(MOD_ID, true, 11),
  'other-key': sessionFor(OTHER_ID, false, 12),
};

type Served = { status: number; body?: Record<string, unknown>; headers: Record<string, string> };

async function call({
  authorization,
  downloadLink = '1',
  queryToken,
  etag,
  row = {},
  file = {},
}: {
  authorization?: string;
  downloadLink?: string;
  queryToken?: string;
  etag?: string;
  row?: Partial<typeof baseRow>;
  file?: Record<string, unknown>;
} = {}): Promise<Served> {
  dbMock.dbWrite.$queryRaw.mockReset();
  dbMock.dbWrite.$queryRaw
    .mockResolvedValueOnce([{ ...baseRow, ...row }])
    .mockResolvedValueOnce([{ ...structuredClone(FILE), ...file }]);
  const headers: Record<string, string> = {};
  const query: Record<string, string> = { id: String(VERSION_ID) };
  if (downloadLink) query.downloadLink = downloadLink;
  if (queryToken) query.token = queryToken;
  if (etag) query.etag = etag;
  const req = {
    method: 'GET',
    url: `${URL}?${new URLSearchParams(query).toString()}`,
    query,
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

/** Without X-Expires, which moves by the ms between two calls; compared on its own. */
const withoutExpires = (served: Served) => ({
  ...served,
  headers: { ...served.headers, 'x-expires': undefined },
});

const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  h.hubSession.value = null;
  h.bearerSession.mockReset();
  h.bearerSession.mockImplementation(async (token: string) => KEYS[token] ?? null);
  h.flagModes = new Set(['provider']);
  h.scopeGate.value = null;
  h.notUpToDate.value = false;
  h.check.mockReset();
  h.check.mockResolvedValue({
    ok: true,
    modelId: 77,
    modelVersionId: VERSION_ID,
    fileId: FILE.id,
    fileUrl: FILE.url,
    fileName: FILE.name,
    sizeKB: FILE.sizeKB,
    nsfw: false,
    inEarlyAccess: false,
    isPublic: true,
  });
  h.findReusableLink.mockReset();
  h.findReusableLink.mockResolvedValue(null);
  h.createLink.mockReset();
  h.createLink.mockResolvedValue({ id: 'L'.repeat(22), linkId: 'P'.repeat(22) });
  setEnv({
    DOWNLOAD_LINK_API_KEY_IDS: [String(ORCH_KEY_ID), '32', '33'],
    DOWNLOAD_LINK_PROVIDER_API_KEY_IDS: [String(ORCH_KEY_ID), '32', '33'],
    DOWNLOAD_LINK_SECRET: 'test-secret-0123456789abcdef0123456789',
    DOWNLOAD_LINK_MIN_REUSE_SECONDS: 7200,
  });
});

describe('mini/[id] downloadLink', () => {
  it('hands the allowlisted key a link to the file it describes, private and unstored', async () => {
    const before = Date.now();
    const { status, body, headers } = await call({ authorization: 'Bearer orch-key' });
    expect(status).toBe(200);
    expect(body?.downloadLink).toEqual({
      url: expect.stringMatching(/\/api\/download\/l\/L{22}$/),
      expiresAt: expect.any(String),
    });
    const expiresAt = Date.parse((body?.downloadLink as { expiresAt: string }).expiresAt);
    expect(expiresAt - before).toBeGreaterThanOrEqual(6 * HOUR);
    expect(h.createLink).toHaveBeenCalledWith(
      expect.objectContaining({
        modelVersionId: VERSION_ID,
        fileId: FILE.id,
        provider: 'orchestrator',
      })
    );
    expect(headers['cache-control']).toBe('private, no-store');
    // The moderation hour is sooner than the link's refresh.
    const expires = Date.parse(headers['x-expires']);
    expect(expires).toBeGreaterThanOrEqual(before + HOUR);
    expect(expires).toBeLessThanOrEqual(Date.now() + HOUR);
  });

  it('sets X-Expires below the reuse floor when the link expires before the moderation hour', async () => {
    const expiresAt = Date.now() + 2.5 * HOUR;
    h.findReusableLink.mockResolvedValue({
      id: 'R'.repeat(22),
      link: { linkId: 'Q'.repeat(22), expiresAt },
    });
    const { body, headers } = await call({ authorization: 'Bearer orch-key' });
    expect(body?.downloadLink).toMatchObject({ url: expect.stringContaining('R'.repeat(22)) });
    expect(Date.parse(headers['x-expires'])).toBe(expiresAt - (2 * HOUR - 10 * 60 * 1000));
  });

  it('keeps a link out of shared caches and expires the response by it, without a moderation block', async () => {
    const { body, headers } = await call({ authorization: 'Bearer orch-plain-key' });
    expect(body).not.toHaveProperty('moderation');
    const { expiresAt } = body?.downloadLink as { expiresAt: string };
    expect(headers['cache-control']).toBe('private, no-store');
    expect(Date.parse(headers['x-expires'])).toBeLessThan(Date.parse(expiresAt));
  });

  it("keeps the wrapper's minute when a stale ?etag sets one", async () => {
    h.notUpToDate.value = true;
    const before = Date.now();
    const { body, headers } = await call({ authorization: 'Bearer orch-key', etag: '0/1' });
    expect(body).toHaveProperty('downloadLink');
    expect(Date.parse(headers['x-expires']) - before).toBeLessThanOrEqual(61_000);
  });

  it.each([
    ['without ?downloadLink=1', { authorization: 'Bearer orch-key', downloadLink: '' }],
    ['with ?downloadLink=0', { authorization: 'Bearer orch-key', downloadLink: '0' }],
    ['to a moderator key not on the allowlist', { authorization: 'Bearer mod-key' }],
    ['to a non-moderator key', { authorization: 'Bearer other-key' }],
    ['to an anonymous caller', {}],
    ['to the allowlisted key sent as ?token=', { queryToken: 'orch-key' }],
  ])('hands no link %s', async (_name, input) => {
    const served = await call(input);
    expect(served.status).toBe(200);
    expect(served.body).not.toHaveProperty('downloadLink');
    expect(h.createLink).not.toHaveBeenCalled();
  });

  it('hands no link to an allowlisted key the scope gate refuses', async () => {
    h.scopeGate.value = 'enforce';
    const { body } = await call({ authorization: 'Bearer orch-unscoped-key' });
    expect(body).not.toHaveProperty('downloadLink');
    expect(h.createLink).not.toHaveBeenCalled();
    // Control: under the gate's `log` mode the same key is not refused.
    h.scopeGate.value = 'log';
    const logged = await call({ authorization: 'Bearer orch-unscoped-key' });
    expect(logged.body).toHaveProperty('downloadLink');
  });

  it("hands no link on the epoch arm, whose url is the orchestrator's own", async () => {
    const epochUrl =
      'https://orchestration.example/v2/consumer/jobs/j1/assets/epoch-10.safetensors';
    const trainingResults = { epochs: [{ epoch_number: 10, model_url: epochUrl }] };
    const { status, body } = await call({
      authorization: 'Bearer orch-key',
      row: { availability: 'Private' },
      file: { metadata: { format: 'SafeTensor', trainingResults } },
    });
    expect(status).toBe(200);
    expect(body?.downloadUrls).toEqual([epochUrl]);
    expect(body).not.toHaveProperty('downloadLink');
    expect(h.createLink).not.toHaveBeenCalled();
  });

  describe("answers the allowlisted key with today's response", () => {
    const expectToday = async () => {
      const expected = await call({ authorization: 'Bearer orch-key', downloadLink: '' });
      const served = await call({ authorization: 'Bearer orch-key' });
      expect(withoutExpires(served)).toEqual(withoutExpires(expected));
      const drift =
        Date.parse(served.headers['x-expires']) - Date.parse(expected.headers['x-expires']);
      expect(Math.abs(drift)).toBeLessThan(1000);
      expect(served.body).not.toHaveProperty('downloadLink');
    };

    it('without DOWNLOAD_LINK_SECRET, minting nothing', async () => {
      setEnv({ DOWNLOAD_LINK_SECRET: undefined });
      await expectToday();
      expect(h.findReusableLink).not.toHaveBeenCalled();
      expect(h.createLink).not.toHaveBeenCalled();
    });

    it('while the flag is off or missing, minting nothing', async () => {
      h.flagModes = new Set();
      await expectToday();
      h.flagModes = new Set(['api']);
      await expectToday();
      expect(h.findReusableLink).not.toHaveBeenCalled();
      expect(h.createLink).not.toHaveBeenCalled();
    });

    it('when the mint fails', async () => {
      h.createLink.mockRejectedValue(new Error('redis down'));
      await expectToday();
    });

    it('when the access check refuses the file', async () => {
      h.check.mockResolvedValue({ ok: false, error: 'no-access' });
      await expectToday();
    });
  });
});
