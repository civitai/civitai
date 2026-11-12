import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { TokenScope, TokenScopePresets } from '~/shared/constants/token-scope.constants';

/**
 * `GET /api/v1/model-versions/mini/[id]` and the scope of the bearer credential that reaches it:
 * the caller class of a Private version's epoch arm, and the answer for a `modelFileId` the caller
 * may not see.
 */

const h = vi.hoisted(() => ({
  user: undefined as undefined | Record<string, unknown>,
  context: undefined as undefined | Record<string, unknown>,
  variants: {} as Record<string, string | null>,
  hasEntityAccess: vi.fn(),
  refreshBlobs: vi.fn(),
}));

vi.mock('~/server/services/orchestrator/refreshBlobs', () => ({
  refreshBlobsService: h.refreshBlobs,
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: async () => 'owner-token',
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
  getFliptVariant: vi.fn(async (flag: string) => h.variants[flag] ?? null),
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  MixedAuthEndpoint:
    (handler: (req: NextApiRequest, res: NextApiResponse, user: unknown) => unknown) =>
    (req: NextApiRequest & { context?: Record<string, unknown> }, res: NextApiResponse) => {
      // What getServerAuthSession records for the credential it resolved.
      if (h.context) req.context = { ...h.context };
      return handler(req, res, h.user);
    },
}));

import handler from '~/pages/api/v1/model-versions/mini/[id]';
import {
  EPOCH_URL,
  GRANTEE_ID,
  OWNER_ID,
  TRAINING_FILE,
  VERSION_ID,
  versionRow,
} from './mini-epoch-fixtures';

const STRANGER_ID = 9001;
const BLOB_ID = 'BLOBID0000000000000000000.safetensors';
const STORED = `https://orchestration-new.civitai.com/v2/consumer/blobs/${BLOB_ID}?sig=s&exp=2026-11-04T00:00:00Z`;
const FRESH = `https://orchestration-new.civitai.com/v2/consumer/blobs/${BLOB_ID}?sig=f&exp=2099-01-01T00:00:00Z`;
const BLOB_FILE = {
  ...TRAINING_FILE,
  metadata: {
    ...TRAINING_FILE.metadata,
    trainingResults: { epochs: [{ epoch_number: 10, model_url: STORED }] },
  },
};
const HIDDEN_FILE = {
  ...TRAINING_FILE,
  id: 405,
  name: 'hidden.safetensors',
  metadata: { format: 'SafeTensor' },
  hashes: { SHA256: 'E'.repeat(64) },
};
const PUBLIC_FILE = {
  ...TRAINING_FILE,
  id: 406,
  visibility: 'Public',
  name: 'public.safetensors',
  metadata: { format: 'SafeTensor' },
  hashes: { SHA256: 'F'.repeat(64) },
};

type Caller = { user?: Record<string, unknown>; context?: Record<string, unknown> };

const bearer = (tokenScope: number | undefined, subject: 'apiKey' | 'oauth' = 'oauth') => ({
  apiKeyId: 6,
  apiKeyType: subject === 'oauth' ? 'Access' : 'User',
  subject: { type: subject, id: subject === 'oauth' ? 'client-abc' : 6 },
  ...(tokenScope === undefined ? {} : { tokenScope }),
});

async function request(caller: Caller, files: object[], query: Record<string, string> = {}) {
  h.user = caller.user;
  h.context = caller.context;
  dbMock.dbWrite.$queryRaw.mockReset();
  dbMock.dbWrite.$queryRaw
    .mockResolvedValueOnce([{ ...versionRow }])
    .mockResolvedValueOnce(structuredClone(files));
  const headers: [string, unknown][] = [];
  const json = vi.fn().mockReturnThis();
  const res = {
    status: vi.fn().mockReturnThis(),
    json,
    setHeader: vi.fn((name: string, value: unknown) => {
      headers.push([name, value]);
      return res;
    }),
  } as unknown as NextApiResponse;
  await handler(
    {
      method: 'GET',
      query: { id: String(VERSION_ID), ...query },
      headers: {
        host: 'civitai.com',
        ...(caller.context ? { authorization: 'Bearer the-token' } : {}),
      },
    } as unknown as NextApiRequest,
    res
  );
  const body = json.mock.calls.at(-1)?.[0] as Record<string, unknown>;
  const status = vi.mocked(res.status).mock.calls.at(-1)?.[0];
  return { status, body, headers };
}

const callerClass = () =>
  (loggingMock.logToAxiom.mock.calls as unknown as [Record<string, unknown>][])
    .map(([entry]) => entry)
    .filter((entry) => entry?.name === 'mini-epoch-caller')
    .map((entry) => entry.callerClass);

beforeEach(() => {
  loggingMock.logToAxiom.mockClear();
  h.variants = { 'mini-epoch-caller-gate': 'enforce', 'download-scope-gate': 'enforce' };
  h.hasEntityAccess.mockReset();
  h.hasEntityAccess.mockImplementation(
    async ({ entityIds, userId }: { entityIds: number[]; userId: number }) =>
      entityIds.map((entityId) => ({ entityId, hasAccess: userId === GRANTEE_ID }))
  );
  h.refreshBlobs.mockReset();
  h.refreshBlobs.mockResolvedValue([{ blobId: BLOB_ID, status: 'refreshed', url: FRESH }]);
  setEnv({ ORCHESTRATOR_SERVICE_TOKEN: 'test-service-token-0123456789abcdef' });
});

describe('mini/[id] epoch arm, a bearer without a download scope', () => {
  it.each([
    ['an OAuth token with UserRead for the owner', OWNER_ID, bearer(TokenScope.UserRead)],
    ['an OAuth token with UserRead for a grantee', GRANTEE_ID, bearer(TokenScope.UserRead)],
    ['a credential recorded with no scope', OWNER_ID, bearer(undefined, 'apiKey')],
  ])('classes %s as other', async (_label, userId, context) => {
    const { status, body } = await request({ user: { id: userId }, context }, [TRAINING_FILE]);
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'Model not found' });
    expect(callerClass()).toEqual(['other']);
  });

  it('is not signed again when the caller gate is off', async () => {
    h.variants['mini-epoch-caller-gate'] = null;
    const { body } = await request(
      { user: { id: OWNER_ID }, context: bearer(TokenScope.UserRead) },
      [BLOB_FILE]
    );
    expect(body.downloadUrls).toEqual([STORED]);
    expect(h.refreshBlobs).not.toHaveBeenCalled();
  });

  it.each([
    ['AIServicesRead', TokenScope.AIServicesRead],
    ['ModelsRead', TokenScope.ModelsRead],
    ['the AI Services preset', TokenScopePresets.AIServices],
  ])("keeps the owner's class for a token with %s", async (_label, tokenScope) => {
    const { status, body } = await request(
      { user: { id: OWNER_ID }, context: bearer(tokenScope) },
      [TRAINING_FILE]
    );
    expect(status).toBe(200);
    expect(body.downloadUrls).toEqual([EPOCH_URL]);
    expect(callerClass()).toEqual(['owner']);
  });

  it('keeps the class under the scope flag off and log', async () => {
    for (const mode of [null, 'log']) {
      loggingMock.logToAxiom.mockClear();
      h.variants['download-scope-gate'] = mode;
      const { body } = await request(
        { user: { id: OWNER_ID }, context: bearer(TokenScope.UserRead) },
        [TRAINING_FILE]
      );
      expect(body.downloadUrls).toEqual([EPOCH_URL]);
      expect(callerClass()).toEqual(['owner']);
    }
  });
});

describe('mini/[id], a moderator', () => {
  it('with a scoped key is not classed as a moderator; with a full personal key it is', async () => {
    const moderator = { id: 1, isModerator: true };
    await request({ user: moderator, context: bearer(TokenScopePresets.ReadOnly, 'apiKey') }, [
      TRAINING_FILE,
    ]);
    expect(callerClass()).toEqual(['other']);

    loggingMock.logToAxiom.mockClear();
    const { body } = await request(
      { user: moderator, context: bearer(TokenScope.Full, 'apiKey') },
      [TRAINING_FILE]
    );
    expect(body.downloadUrls).toEqual([EPOCH_URL]);
    expect(callerClass()).toEqual(['moderator']);
  });
});

describe('mini/[id]?modelFileId= for a file the caller may not see', () => {
  const FILES = [TRAINING_FILE, HIDDEN_FILE, PUBLIC_FILE];
  const ask = (caller: Caller, modelFileId: number) =>
    request(caller, FILES, { modelFileId: String(modelFileId) });

  it.each([
    ['anonymous', {}],
    ['signed in with no grant', { user: { id: STRANGER_ID } }],
    [
      'a full-scope key with no grant',
      { user: { id: STRANGER_ID }, context: bearer(TokenScope.Full, 'apiKey') },
    ],
  ])(
    '%s: a hidden training file, a hidden file and a nonexistent id answer alike',
    async (_label, caller: Caller) => {
      for (const variant of [null, 'log', 'enforce']) {
        h.variants['mini-epoch-caller-gate'] = variant;
        const nonexistent = await ask(caller, 999);
        const nonexistentBody = JSON.stringify(nonexistent.body).replace('999', 'ID');
        for (const hiddenId of [TRAINING_FILE.id, HIDDEN_FILE.id]) {
          const hidden = await ask(caller, hiddenId);
          expect(hidden.status).toBe(404);
          expect(hidden.status).toBe(nonexistent.status);
          expect(JSON.stringify(hidden.body).replace(String(hiddenId), 'ID')).toBe(nonexistentBody);
          expect(hidden.headers).toEqual(nonexistent.headers);
        }
      }
    }
  );

  it('still serves a visible file by id', async () => {
    const { status, body } = await ask({ user: { id: STRANGER_ID } }, PUBLIC_FILE.id);
    expect(status).toBe(200);
    expect(JSON.stringify(body)).toContain(PUBLIC_FILE.hashes.SHA256);
  });

  it('gives the owner the epoch url for the training file', async () => {
    const { body } = await ask({ user: { id: OWNER_ID } }, TRAINING_FILE.id);
    expect(body.downloadUrls).toEqual([EPOCH_URL]);
  });

  it('keeps the grantee class for the training file', async () => {
    const { body } = await ask({ user: { id: GRANTEE_ID } }, TRAINING_FILE.id);
    expect(body.downloadUrls).toEqual([EPOCH_URL]);
    expect(callerClass()).toEqual(['grantee']);
  });
});
