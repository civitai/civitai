import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

/**
 * The mini epoch arm behind its real `MixedAuthEndpoint` and `getServerAuthSession`, so the
 * credential kinds it logs and the service token it accepts come from the real session layer.
 * Only the credential lookups below that layer are faked.
 */

const h = vi.hoisted(() => ({
  bearerSession: vi.fn(),
  hasEntityAccess: vi.fn(),
  variant: { value: 'enforce' as string | null },
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
  getFliptVariant: vi.fn(async (flag: string) =>
    flag === 'mini-epoch-caller-gate' ? h.variant.value : null
  ),
}));

import {
  EPOCH_URL,
  GRANTEE_ID,
  SERVICE_TOKEN,
  TRAINING_FILE,
  VERSION_ID,
  versionRow,
} from './mini-epoch-fixtures';

const handler = (await import('~/pages/api/v1/model-versions/mini/[id]')).default as unknown as (
  req: NextApiRequest,
  res: NextApiResponse
) => Promise<void>;

const keySession = (userId: number, subject: 'apiKey' | 'oauth') => ({
  user: { id: userId, username: 'someone', bannedAt: null, isModerator: false },
  apiKeyId: 11,
  apiKeyType: subject === 'oauth' ? 'Access' : 'User',
  subject: { type: subject, id: subject === 'oauth' ? 'client-abc' : 11 },
  tokenScope: 0,
  buzzLimit: null,
});

async function call(authorization?: string, versionRows: object[] = [versionRow]) {
  dbMock.dbWrite.$queryRaw.mockReset();
  dbMock.dbWrite.$queryRaw
    .mockResolvedValueOnce(versionRows)
    .mockResolvedValueOnce([structuredClone(TRAINING_FILE)]);
  const headers: Record<string, string> = {};
  const req = {
    method: 'GET',
    url: `/api/v1/model-versions/mini/${VERSION_ID}`,
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
  const log = (loggingMock.logToAxiom.mock.calls as unknown as [Record<string, unknown>][])
    .map(([entry]) => entry)
    .filter((entry) => entry?.name === 'mini-epoch-caller');
  return { status, body, headers, log };
}

beforeEach(() => {
  loggingMock.logToAxiom.mockClear();
  h.variant.value = 'enforce';
  h.bearerSession.mockReset();
  h.bearerSession.mockResolvedValue(null);
  h.hasEntityAccess.mockReset();
  h.hasEntityAccess.mockImplementation(
    async ({ entityIds, userId }: { entityIds: number[]; userId: number }) =>
      entityIds.map((entityId) => ({ entityId, hasAccess: userId === GRANTEE_ID }))
  );
  setEnv({ ORCHESTRATOR_SERVICE_TOKEN: SERVICE_TOKEN });
});

describe('mini/[id] epoch arm through the real session layer, enforce', () => {
  it('serves the service token, which the session layer resolves to no session, privately', async () => {
    const { status, body, headers, log } = await call(`Bearer ${SERVICE_TOKEN}`);
    expect(h.bearerSession).toHaveBeenCalledTimes(1);
    expect(status).toBe(200);
    expect(body?.downloadUrls).toEqual([EPOCH_URL]);
    expect(headers['cache-control']).toMatch(/\bprivate\b/);
    expect(log).toEqual([
      expect.objectContaining({ callerClass: 'orchestrator', resolvedAs: 'orchestrator' }),
    ]);
  });

  it('serves a grantee by personal API key, logged as one', async () => {
    h.bearerSession.mockResolvedValue(keySession(GRANTEE_ID, 'apiKey'));
    const { body, log } = await call('Bearer personal-key');
    expect(body?.downloadUrls).toEqual([EPOCH_URL]);
    expect(log).toEqual([
      expect.objectContaining({ callerClass: 'grantee', resolvedAs: 'api-key' }),
    ]);
  });

  it('answers an OAuth caller with no grant as an unknown id, logged as OAuth', async () => {
    h.bearerSession.mockResolvedValue(keySession(9001, 'oauth'));
    const { status, body, log } = await call('Bearer oauth-token');
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'Model not found' });
    expect(log).toEqual([expect.objectContaining({ callerClass: 'other', resolvedAs: 'oauth' })]);
  });

  it('answers a token the session layer does not know as an unknown id', async () => {
    const { status, body, log } = await call('Bearer not-a-key');
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'Model not found' });
    expect(log).toEqual([
      expect.objectContaining({ callerClass: 'anonymous', resolvedAs: 'unrecognized' }),
    ]);
  });

  it.each([
    ['an anonymous caller', undefined],
    ['a caller with a bearer token', 'Bearer not-a-key'],
  ])('answers %s refused with the same headers as an unknown id', async (_label, authorization) => {
    const refused = await call(authorization);
    const unknown = await call(authorization, []);
    expect(refused.status).toBe(404);
    expect(refused.log).toHaveLength(1);
    expect(unknown.status).toBe(404);
    expect(refused.headers).toEqual(unknown.headers);
    expect(refused.body).toEqual(unknown.body);
  });
});
