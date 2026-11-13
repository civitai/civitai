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

describe('mini/[id], the internal system account', () => {
  const SYSTEM_ID = -1;
  const modes = [null, 'log', 'enforce', 'enforce-anon'].flatMap((epochMode) =>
    [null, 'log', 'enforce'].map((scopeMode) => [epochMode, scopeMode] as const)
  );

  it.each(modes)(
    'keeps the moderator class with a ModelsRead key, signed again (caller gate %s, scope gate %s)',
    async (epochMode, scopeMode) => {
      h.variants = { 'mini-epoch-caller-gate': epochMode, 'download-scope-gate': scopeMode };
      const { status, body } = await request(
        {
          user: { id: SYSTEM_ID, username: 'civitai', isModerator: true },
          context: bearer(TokenScope.ModelsRead, 'apiKey'),
        },
        [BLOB_FILE]
      );
      expect(status).toBe(200);
      expect(body.downloadUrls).toEqual([FRESH]);
      expect(h.refreshBlobs).toHaveBeenCalledTimes(1);
      if (epochMode) expect(callerClass()).toEqual(['moderator']);
    }
  );

  it.each([
    ['another moderator', { id: 31, username: 'mod', isModerator: true }],
    [
      'an account that claims to be the system account by anything but its id',
      { id: 32, username: 'civitai', isModerator: true, meta: { systemAccount: true } },
    ],
  ])('downgrades %s holding the same key', async (_label, user) => {
    h.variants['mini-epoch-caller-gate'] = null;
    const { body } = await request({ user, context: bearer(TokenScope.ModelsRead, 'apiKey') }, [
      BLOB_FILE,
    ]);
    expect(body.downloadUrls).toEqual([STORED]);
    expect(h.refreshBlobs).not.toHaveBeenCalled();

    h.variants['mini-epoch-caller-gate'] = 'enforce';
    loggingMock.logToAxiom.mockClear();
    const refused = await request({ user, context: bearer(TokenScope.ModelsRead, 'apiKey') }, [
      TRAINING_FILE,
    ]);
    expect(refused.status).toBe(404);
    expect(callerClass()).toEqual(['other']);
  });
});

describe('mini/[id], the orchestrator service token', () => {
  const SERVICE = 'test-service-token-0123456789abcdef';
  async function asService(files: object[], query: Record<string, string> = {}) {
    h.user = undefined;
    h.context = undefined;
    dbMock.dbWrite.$queryRaw.mockReset();
    dbMock.dbWrite.$queryRaw
      .mockResolvedValueOnce([{ ...versionRow }])
      .mockResolvedValueOnce(structuredClone(files));
    const json = vi.fn().mockReturnThis();
    const res = {
      status: vi.fn().mockReturnThis(),
      json,
      setHeader: vi.fn().mockReturnThis(),
    } as unknown as NextApiResponse;
    await handler(
      {
        method: 'GET',
        query: { id: String(VERSION_ID), ...query },
        headers: { host: 'civitai.com', authorization: `Bearer ${SERVICE}` },
      } as unknown as NextApiRequest,
      res
    );
    return json.mock.calls.at(-1)?.[0] as Record<string, unknown>;
  }

  it.each([null, 'log', 'enforce', 'enforce-anon'])(
    'is served the epoch url, by primary pick and by id, signed again (caller gate %s)',
    async (epochMode) => {
      h.variants = { 'mini-epoch-caller-gate': epochMode, 'download-scope-gate': 'enforce' };
      expect((await asService([BLOB_FILE, PUBLIC_FILE])).downloadUrls).toEqual([FRESH]);
      expect(
        (await asService([BLOB_FILE, PUBLIC_FILE], { modelFileId: String(BLOB_FILE.id) }))
          .downloadUrls
      ).toEqual([FRESH]);
      expect(h.refreshBlobs).toHaveBeenCalledTimes(2);
    }
  );
});

describe('mini/[id]?modelFileId= by an owner whose credential lacks the scope', () => {
  const owner: Caller = { user: { id: OWNER_ID }, context: bearer(TokenScope.UserRead) };
  const FILES = [TRAINING_FILE, HIDDEN_FILE, PUBLIC_FILE];

  it('under enforce, a hidden file answers like a nonexistent one', async () => {
    const nonexistent = await request(owner, FILES, { modelFileId: '999' });
    const hidden = await request(owner, FILES, { modelFileId: String(TRAINING_FILE.id) });
    expect(hidden.status).toBe(404);
    expect(JSON.stringify(hidden.body).replace(String(TRAINING_FILE.id), 'ID')).toBe(
      JSON.stringify(nonexistent.body).replace('999', 'ID')
    );
    expect(hidden.headers).toEqual(nonexistent.headers);
  });

  it.each([null, 'log'])('under %s, the training file is still served', async (mode) => {
    h.variants['download-scope-gate'] = mode;
    const { body } = await request(owner, FILES, { modelFileId: String(TRAINING_FILE.id) });
    expect(body.downloadUrls).toEqual([EPOCH_URL]);
  });

  it('a moderator by a full-scope key is served a hidden file by id', async () => {
    const { body } = await request(
      { user: { id: 1, isModerator: true }, context: bearer(TokenScope.Full, 'apiKey') },
      FILES,
      { modelFileId: String(TRAINING_FILE.id) }
    );
    expect(body.downloadUrls).toEqual([EPOCH_URL]);
  });
});

describe('mini/[id], the primary file hidden from the caller', () => {
  it('log: the caller line names it as its own reason', async () => {
    h.variants['mini-epoch-caller-gate'] = 'log';
    await request({}, [TRAINING_FILE]);
    await request({ user: { id: OWNER_ID } }, [TRAINING_FILE]);
    const picks = (loggingMock.logToAxiom.mock.calls as unknown as [Record<string, unknown>][])
      .map(([entry]) => entry)
      .filter((entry) => entry?.name === 'mini-epoch-caller')
      .map((entry) => entry.pick);
    expect(picks).toEqual(['hidden-primary', 'primary']);
  });
});

describe('mini/[id], the system account', () => {
  const system = { id: -1, username: 'civitai', isModerator: true };

  it('is not a moderator by an OAuth token', async () => {
    h.variants['mini-epoch-caller-gate'] = 'enforce';
    await request({ user: system, context: bearer(TokenScope.Full, 'oauth') }, [TRAINING_FILE]);
    expect(callerClass()).toEqual(['other']);
  });

  it('gets no moderation block by a key the scope gate refuses under enforce', async () => {
    const refused = await request(
      { user: system, context: bearer(TokenScope.UserRead, 'apiKey') },
      [PUBLIC_FILE]
    );
    expect(refused.status).toBe(200);
    expect(refused.body).not.toHaveProperty('moderation');

    // Control: with the route scope it keeps the moderator view.
    const allowed = await request(
      { user: system, context: bearer(TokenScope.ModelsRead, 'apiKey') },
      [PUBLIC_FILE]
    );
    expect(allowed.body).toHaveProperty('moderation');
  });
});

describe('mini/[id] ?epoch=, a credential the scope gate refuses', () => {
  const EARLY =
    'https://orchestration.civitai.com/v2/consumer/jobs/job-abc-123/assets/epoch-000005.safetensors';
  const twoEpochs = {
    ...TRAINING_FILE,
    metadata: {
      ...TRAINING_FILE.metadata,
      trainingResults: {
        epochs: [
          { epoch_number: 5, model_url: EARLY },
          { epoch_number: 10, model_url: STORED },
        ],
      },
    },
  };

  it.each([null, 'log'])('caller gate %s: the owner does not pick the epoch', async (epochMode) => {
    h.variants = { 'mini-epoch-caller-gate': epochMode, 'download-scope-gate': 'enforce' };
    const refused: Caller = { user: { id: OWNER_ID }, context: bearer(TokenScope.UserRead) };
    const unnamed = await request(refused, [twoEpochs]);
    expect(unnamed.body.downloadUrls).toEqual([STORED]);
    expect(await request(refused, [twoEpochs], { epoch: '5' })).toEqual(unnamed);
    // Control: a key with a download scope picks it.
    const { body } = await request(
      { user: { id: OWNER_ID }, context: bearer(TokenScope.ModelsRead, 'apiKey') },
      [twoEpochs],
      { epoch: '5' }
    );
    expect(body.downloadUrls).toEqual([EARLY]);
  });
});
