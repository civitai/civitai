import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

/**
 * `GET /api/v1/model-versions/mini/[id]`, the epoch arm of a Private version, behind the
 * `mini-epoch-caller-gate` variant flag: `log` logs the caller class, `enforce` also answers callers
 * who are not the owner, a moderator, a grantee or the orchestrator as an unknown id.
 */

const h = vi.hoisted(() => ({
  user: { value: undefined as undefined | Record<string, unknown> },
  variant: { value: null as string | null },
  hasEntityAccess: vi.fn(),
  getFliptVariant: vi.fn(),
}));

vi.mock('~/server/services/generation/generation.service', () => ({
  resolveCanGenerateForVersions: vi.fn(async () => new Map([[VERSION_ID, { canGenerate: true }]])),
  getShouldChargeForResources: vi.fn(async () => ({ 77: false })),
}));
vi.mock('~/server/services/model.service', () => ({
  getFeaturedModels: vi.fn(async () => []),
}));
vi.mock('~/server/services/common.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasEntityAccess: h.hasEntityAccess,
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFliptVariant: h.getFliptVariant,
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  MixedAuthEndpoint:
    (handler: (req: NextApiRequest, res: NextApiResponse, user: unknown) => unknown) =>
    (req: NextApiRequest, res: NextApiResponse) =>
      handler(req, res, h.user.value),
}));

import handler from '~/pages/api/v1/model-versions/mini/[id]';
import {
  EPOCH_URL,
  GRANTEE_ID,
  OWNER_ID,
  SERVICE_TOKEN,
  TRAINING_FILE,
  VERSION_ID,
  versionRow,
} from './mini-epoch-fixtures';

const STRANGER_ID = 9001;

type Caller = {
  user?: Record<string, unknown>;
  authorization?: string;
  /** What getServerAuthSession recorded for a bearer credential it resolved. */
  subject?: 'apiKey' | 'oauth';
};

async function request(
  caller: Caller = {},
  row: Partial<typeof versionRow> = {},
  file: object = TRAINING_FILE,
  versionRows: object[] = [{ ...versionRow, ...row }]
) {
  h.user.value = caller.user;
  dbMock.dbWrite.$queryRaw.mockReset();
  dbMock.dbWrite.$queryRaw
    .mockResolvedValueOnce(versionRows)
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
      headers: {
        host: 'civitai.com',
        ...(caller.authorization ? { authorization: caller.authorization } : {}),
      },
      ...(caller.subject ? { context: { subject: { type: caller.subject } } } : {}),
    } as unknown as NextApiRequest,
    res
  );
  const body = json.mock.calls.at(-1)?.[0] as Record<string, unknown>;
  const status = (res.status as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
  const cacheControl = (res.setHeader as unknown as ReturnType<typeof vi.fn>).mock.calls
    .filter(([name]) => name === 'Cache-Control')
    .at(-1)?.[1];
  return { status, body, cacheControl };
}

/** The unknown-id 404, carrying nothing that names the epoch, its file or its hash. */
function expectRefused({ status, body }: { status: unknown; body: unknown }) {
  expect(status).toBe(404);
  expect(body).toEqual({ error: 'Model not found' });
  const text = JSON.stringify(body);
  for (const leak of [TRAINING_FILE.hashes.SHA256, TRAINING_FILE.name, 'job-abc-123', EPOCH_URL])
    expect(text).not.toContain(leak);
}

function callerLogs() {
  return (loggingMock.logToAxiom.mock.calls as unknown as [Record<string, unknown>][])
    .map(([entry]) => entry)
    .filter((entry) => entry?.name === 'mini-epoch-caller');
}

const owner: Caller = { user: { id: OWNER_ID } };
const moderator: Caller = { user: { id: 1, isModerator: true } };
const grantee: Caller = { user: { id: GRANTEE_ID }, authorization: 'Bearer k', subject: 'apiKey' };
const stranger: Caller = { user: { id: STRANGER_ID }, authorization: 'Bearer k', subject: 'oauth' };
const service: Caller = { authorization: `Bearer ${SERVICE_TOKEN}` };
const anonymous: Caller = {};

beforeEach(() => {
  loggingMock.logToAxiom.mockClear();
  h.variant.value = null;
  h.getFliptVariant.mockReset();
  h.getFliptVariant.mockImplementation(async (flag: string) =>
    flag === 'mini-epoch-caller-gate' ? h.variant.value : null
  );
  h.hasEntityAccess.mockReset();
  h.hasEntityAccess.mockImplementation(
    async ({ entityIds, userId }: { entityIds: number[]; userId: number }) =>
      entityIds.map((entityId) => ({ entityId, hasAccess: userId === GRANTEE_ID }))
  );
  setEnv({ ORCHESTRATOR_SERVICE_TOKEN: SERVICE_TOKEN });
});

describe('mini/[id] epoch arm, enforce', () => {
  beforeEach(() => {
    h.variant.value = 'enforce';
  });

  it.each([
    ['the owner', owner, 'owner'],
    ['a moderator', moderator, 'moderator'],
    ['a grantee', grantee, 'grantee'],
    ['the orchestrator service token', service, 'orchestrator'],
  ])('serves the epoch url to %s', async (_label, caller, callerClass) => {
    const { status, body } = await request(caller);
    expect(status).toBe(200);
    expect(body.downloadUrls).toEqual([EPOCH_URL]);
    expect(callerLogs()).toEqual([
      expect.objectContaining({ callerClass, wouldRefuse: false, enforced: false }),
    ]);
  });

  it.each([
    ['an anonymous caller', anonymous, 'anonymous'],
    ['a signed-in caller with no grant', stranger, 'other'],
    ['a wrong token', { authorization: `Bearer ${SERVICE_TOKEN.slice(0, -1)}x` }, 'anonymous'],
    [
      'a longer token with the right prefix',
      { authorization: `Bearer ${SERVICE_TOKEN}x` },
      'anonymous',
    ],
    [
      'the right token under another scheme',
      { authorization: `Basic ${SERVICE_TOKEN}` },
      'anonymous',
    ],
    [
      'the right token with a trailing part',
      { authorization: `Bearer ${SERVICE_TOKEN} x` },
      'anonymous',
    ],
  ])('answers %s as an unknown id', async (_l, caller, cls) => {
    expectRefused(await request(caller));
    expect(callerLogs()).toEqual([
      expect.objectContaining({ callerClass: cls, wouldRefuse: true, enforced: true }),
    ]);
  });

  it('accepts the scheme in any case', async () => {
    const { body } = await request({ authorization: `bearer ${SERVICE_TOKEN}` });
    expect(body.downloadUrls).toEqual([EPOCH_URL]);
  });

  it('does not accept the service token when none is configured', async () => {
    setEnv({ ORCHESTRATOR_SERVICE_TOKEN: undefined });
    expectRefused(await request(service));
    expect(callerLogs()[0]).toMatchObject({ callerClass: 'anonymous', resolvedAs: 'unrecognized' });
  });

  it('does not accept a blank configured token', async () => {
    setEnv({ ORCHESTRATOR_SERVICE_TOKEN: '\t' });
    expectRefused(await request({ authorization: 'Bearer \t' }));
  });

  it('does not accept an empty configured token against an empty bearer', async () => {
    setEnv({ ORCHESTRATOR_SERVICE_TOKEN: '' });
    expectRefused(await request({ authorization: 'Bearer ' }));
  });

  it('checks a grant for the one version alone', async () => {
    await request(grantee);
    expect(h.hasEntityAccess).toHaveBeenCalledTimes(1);
    expect(h.hasEntityAccess.mock.calls[0][0]).toMatchObject({
      entityType: 'ModelVersion',
      entityIds: [VERSION_ID],
      userId: GRANTEE_ID,
    });
  });

  it('withholds from a signed-in caller when the grant lookup fails', async () => {
    h.hasEntityAccess.mockRejectedValueOnce(new Error('db down'));
    expectRefused(await request(grantee));
  });

  it('still withholds a taken-down model from the service token', async () => {
    const { status, body } = await request(service, { modelMode: 'TakenDown' });
    expect(status).toBe(200);
    expect(body.downloadUrls).toEqual([]);
  });

  it('answers a refused caller exactly as an id that does not exist', async () => {
    const refused = await request(anonymous);
    const unknown = await request(anonymous, {}, TRAINING_FILE, []);
    expect(refused.status).toBe(404);
    expect({ status: refused.status, body: refused.body }).toEqual({
      status: unknown.status,
      body: unknown.body,
    });
  });

  it('keeps the refused 404 out of shared caches', async () => {
    const { cacheControl } = await request(anonymous);
    expect(cacheControl).toBe('private, no-store');
  });

  it.each([
    ['the owner', owner],
    ['the service token', service],
  ])('still gives %s the epoch air and hashes', async (_label, caller) => {
    const { status, body } = await request(caller);
    expect(status).toBe(200);
    expect(body.hashes).toEqual(TRAINING_FILE.hashes);
    expect(body.fileName).toBe(TRAINING_FILE.name);
    expect(body).toHaveProperty('air');
  });
});

describe('mini/[id] epoch arm, log', () => {
  beforeEach(() => {
    h.variant.value = 'log';
  });

  it.each([
    ['an anonymous caller', anonymous],
    ['a signed-in caller with no grant', stranger],
    ['a wrong token', { authorization: 'Bearer nope' }],
  ])('serves %s and logs that enforce would refuse', async (_label, caller) => {
    const { body } = await request(caller);
    expect(body.downloadUrls).toEqual([EPOCH_URL]);
    expect(callerLogs()).toEqual([expect.objectContaining({ wouldRefuse: true, enforced: false })]);
  });

  it.each([
    ['no credential', anonymous, false, 'none'],
    ['a session cookie', owner, false, 'session'],
    ['a personal API key', grantee, true, 'api-key'],
    ['an OAuth token', stranger, true, 'oauth'],
    ['a token that resolved to nothing', { authorization: 'Bearer nope' }, true, 'unrecognized'],
    // getServerAuthSession resolves the service token to no session; the arm still names it.
    ['the service token', service, true, 'orchestrator'],
  ])('logs %s as its kind, with the version id', async (_label, caller, authHeader, resolvedAs) => {
    await request(caller);
    expect(callerLogs()).toEqual([
      expect.objectContaining({ modelVersionId: VERSION_ID, authHeader, resolvedAs }),
    ]);
  });

  it('logs no part of the credential', async () => {
    await request(service);
    await request({ authorization: 'Bearer some-user-key-value' });
    const logged = JSON.stringify(callerLogs());
    expect(callerLogs()).toHaveLength(2);
    for (const entry of callerLogs())
      expect(Object.keys(entry).sort()).toEqual([
        'authHeader',
        'callerClass',
        'enforced',
        'modelVersionId',
        'name',
        'resolvedAs',
        'type',
        'wouldRefuse',
      ]);
    expect(logged).not.toContain(SERVICE_TOKEN.slice(0, 6));
    expect(logged).not.toContain('some-user');
    expect(logged).not.toMatch(/bearer/i);
  });
});

describe('mini/[id] epoch arm, cache', () => {
  it.each(['log', 'enforce'])('%s: no shared cache may store the response', async (variant) => {
    h.variant.value = variant;
    for (const caller of [anonymous, owner, service]) {
      const { cacheControl } = await request(caller);
      expect(cacheControl).toBe('private, no-store');
    }
  });

  it('off: the cache header is left as it was', async () => {
    const { cacheControl } = await request(anonymous);
    expect(cacheControl).toBeUndefined();
  });
});

describe('mini/[id] epoch arm, off', () => {
  it.each([
    ['flag unset', null],
    ['an unknown variant', 'on'],
  ])('%s: serves everyone and logs nothing', async (_label, variant) => {
    h.variant.value = variant;
    for (const caller of [anonymous, stranger, service]) {
      const { body } = await request(caller);
      expect(body.downloadUrls).toEqual([EPOCH_URL]);
    }
    expect(callerLogs()).toEqual([]);
    expect(h.hasEntityAccess).not.toHaveBeenCalled();
  });
});

describe('the service token outside the epoch arm', () => {
  it('a Public version is answered the same with or without it, and the flag is not read', async () => {
    h.variant.value = 'enforce';
    const publicRow = { availability: 'Public' };
    const publicFile = { ...TRAINING_FILE, visibility: 'Public' };
    const without = await request(anonymous, publicRow, publicFile);
    const withToken = await request(service, publicRow, publicFile);
    expect(without.status).toBe(200);
    expect(withToken).toEqual(without);
    expect(callerLogs()).toEqual([]);
    expect(h.getFliptVariant.mock.calls.map(([flag]) => flag)).not.toContain(
      'mini-epoch-caller-gate'
    );
  });
});
