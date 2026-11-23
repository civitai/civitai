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
  refreshBlobs: vi.fn(),
}));

vi.mock('~/server/services/orchestrator/refreshBlobs', () => ({
  refreshBlobsService: h.refreshBlobs,
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: async () => 'owner-token',
}));

vi.mock('~/server/services/generation/generation.service', () => ({
  getGateRuleState: vi.fn(async () => ({ known: true, value: [] })),
  getGateSubjects: vi.fn(async () => new Map()),
  gatedVersionIds: vi.fn(() => new Set()),
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
  versionRows: object[] = [{ ...versionRow, ...row }],
  query: Record<string, string> = {}
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
      query: { id: String(VERSION_ID), ...query },
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

  it('refuses a signed-in caller when the grant lookup fails', async () => {
    h.hasEntityAccess.mockRejectedValueOnce(new Error('db down'));
    expectRefused(await request(grantee));
  });

  it('still withholds a taken-down model from the service token', async () => {
    const { status, body } = await request(service, { modelMode: 'TakenDown' });
    expect(status).toBe(200);
    expect(body.downloadUrls).toEqual([]);
  });

  it('answers a refused caller with the same status, body and cache header as an unknown id', async () => {
    const refused = await request(anonymous);
    const unknown = await request(anonymous, {}, TRAINING_FILE, []);
    expect(refused.status).toBe(404);
    expect(refused).toEqual(unknown);
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
    expect(body.downloadUrls).toEqual([EPOCH_URL]);
    expect(body.hashes).toEqual(TRAINING_FILE.hashes);
    expect(body.fileName).toBe(TRAINING_FILE.name);
    expect(body).toHaveProperty('air');
  });

  it('refuses before the epoch is read: a version with no epochs answers as an unknown id', async () => {
    const noEpochs = {
      ...TRAINING_FILE,
      metadata: { ...TRAINING_FILE.metadata, trainingResults: { epochs: [] } },
    };
    expectRefused(await request(anonymous, {}, noEpochs));
    // control: the owner reaches the epoch read and gets its own error
    const forOwner = await request(owner, {}, noEpochs);
    expect(forOwner).toMatchObject({ status: 404, body: { error: 'Missing epoch' } });
  });
});

describe('mini/[id] epoch arm, enforce-anon', () => {
  beforeEach(() => {
    h.variant.value = 'enforce-anon';
  });

  it('answers a request with no credential as an unknown id, kept out of shared caches', async () => {
    const refused = await request(anonymous);
    expectRefused(refused);
    expect(refused.cacheControl).toBe('private, no-store');
    expect(callerLogs()).toEqual([
      expect.objectContaining({ resolvedAs: 'none', callerClass: 'anonymous', enforced: true }),
    ]);
  });

  it.each([
    ['a bearer that does not resolve', { authorization: 'Bearer not-a-key' }, 'unrecognized'],
    [
      'the owner by API key',
      { user: { id: OWNER_ID }, authorization: 'Bearer k', subject: 'apiKey' as const },
      'api-key',
    ],
    ['a signed-in caller with no grant', stranger, 'oauth'],
    ['a signed-in session with no grant', { user: { id: STRANGER_ID } }, 'session'],
    ['the orchestrator service token', service, 'orchestrator'],
  ])('serves the epoch url to %s', async (_label, caller, resolvedAs) => {
    const { status, body } = await request(caller);
    expect(status).toBe(200);
    expect(body.downloadUrls).toEqual([EPOCH_URL]);
    expect(callerLogs()).toEqual([expect.objectContaining({ resolvedAs, enforced: false })]);
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
  ])('logs %s as its kind', async (_label, caller, authHeader, resolvedAs) => {
    await request(caller);
    expect(callerLogs()).toEqual([
      expect.objectContaining({ payload: { isPrivate: true }, authHeader, resolvedAs }),
    ]);
  });

  it('logs no part of the credential, and no version, model or file', async () => {
    await request(service);
    await request({ authorization: 'Bearer some-user-key-value' });
    const logged = JSON.stringify(callerLogs());
    expect(callerLogs()).toHaveLength(2);
    for (const entry of callerLogs()) {
      expect(Object.keys(entry).sort()).toEqual([
        'authHeader',
        'callerClass',
        'enforced',
        'mode',
        'name',
        'payload',
        'resolvedAs',
        'type',
        'wouldRefuse',
      ]);
      expect(entry.payload).toEqual({ isPrivate: true });
    }
    expect(logged).not.toContain(SERVICE_TOKEN.slice(0, 6));
    expect(logged).not.toContain('some-user');
    expect(logged).not.toMatch(/bearer/i);
  });
});

describe('mini/[id] epoch arm, cache', () => {
  it.each(['log', 'enforce', 'enforce-anon'])(
    '%s: no shared cache may store the response',
    async (variant) => {
      h.variant.value = variant;
      for (const caller of [anonymous, stranger, grantee, owner, moderator, service])
        for (const query of [{}, { epoch: '5' }] as Record<string, string>[]) {
          const { cacheControl } = await request(caller, {}, undefined, undefined, query);
          expect(cacheControl, JSON.stringify({ caller, query })).toBe('private, no-store');
        }
    }
  );

  it('off: the cache header is left as it was', async () => {
    const { cacheControl } = await request(anonymous);
    expect(cacheControl).toBeUndefined();
  });
});

describe('mini/[id] epoch arm, off', () => {
  it.each([
    ['flag unset', null],
    ['an unknown variant', 'on'],
    ['a near miss of enforce-anon', 'Enforce-Anon'],
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

describe('mini/[id] epoch arm, a stored blob url', () => {
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

  beforeEach(() => {
    h.variant.value = 'enforce';
    h.refreshBlobs.mockReset();
    h.refreshBlobs.mockResolvedValue([{ blobId: BLOB_ID, status: 'refreshed', url: FRESH }]);
  });

  it('is signed again once for a caller the gate serves', async () => {
    const { body } = await request(service, {}, BLOB_FILE);

    expect(body.downloadUrls).toEqual([FRESH]);
    expect(h.refreshBlobs).toHaveBeenCalledTimes(1);
  });

  it('keeps the stored url for a caller log mode serves but would refuse', async () => {
    h.variant.value = 'log';

    const { body } = await request(anonymous, {}, BLOB_FILE);

    expect(body.downloadUrls).toEqual([STORED]);
    expect(h.refreshBlobs).not.toHaveBeenCalled();
  });

  it('is not signed for a caller the gate refuses', async () => {
    const { status } = await request(anonymous, {}, BLOB_FILE);

    expect(status).toBe(404);
    expect(h.refreshBlobs).not.toHaveBeenCalled();
  });

  it.each([
    ['a bearer that does not resolve', { authorization: 'Bearer not-a-key' }],
    ['a signed-in caller with no grant', stranger],
  ])('enforce-anon serves %s the stored url, not signed again', async (_label, caller) => {
    h.variant.value = 'enforce-anon';

    const { status, body } = await request(caller, {}, BLOB_FILE);

    expect(status).toBe(200);
    expect(body.downloadUrls).toEqual([STORED]);
    expect(h.refreshBlobs).not.toHaveBeenCalled();
  });

  it('enforce-anon signs it again for the service token', async () => {
    h.variant.value = 'enforce-anon';

    const { body } = await request(service, {}, BLOB_FILE);

    expect(body.downloadUrls).toEqual([FRESH]);
    expect(h.refreshBlobs).toHaveBeenCalledTimes(1);
  });
});

describe('mini/[id] ?epoch= from the query string', () => {
  const EARLY =
    'https://orchestration.civitai.com/v2/consumer/jobs/job-abc-123/assets/epoch-000005.safetensors';
  const twoEpochs = {
    ...TRAINING_FILE,
    metadata: {
      ...TRAINING_FILE.metadata,
      trainingResults: {
        epochs: [
          { epoch_number: 5, model_url: EARLY },
          { epoch_number: 10, model_url: EPOCH_URL },
        ],
      },
    },
  };
  const ask = (query: Record<string, string>) => request(owner, {}, twoEpochs, undefined, query);

  beforeEach(() => {
    h.variant.value = 'enforce';
  });

  it('serves the named epoch from epochs written as epochNumber', async () => {
    const v2 = {
      ...twoEpochs,
      metadata: {
        ...twoEpochs.metadata,
        trainingResults: {
          epochs: [
            { epochNumber: 5, modelUrl: EARLY },
            { epochNumber: 10, modelUrl: EPOCH_URL },
          ],
        },
      },
    };
    const { status, body } = await request(owner, {}, v2, undefined, { epoch: '5' });
    expect(status).toBe(200);
    expect(body.downloadUrls).toEqual([EARLY]);
  });

  it('400s a repeated epoch', async () => {
    const { status } = await request(owner, {}, twoEpochs, undefined, {
      epoch: ['5', '10'] as unknown as string,
    });
    expect(status).toBe(400);
  });

  it('serves the latest epoch when none is named', async () => {
    const { status, body } = await ask({});
    expect(status).toBe(200);
    expect(body.downloadUrls).toEqual([EPOCH_URL]);
  });

  it.each([
    ['a word', 'latest'],
    ['a fraction', '5.5'],
  ])('400s an epoch that is %s', async (_, epoch) => {
    expect((await ask({ epoch })).status).toBe(400);
  });

  describe.each(['log', 'enforce', 'enforce-anon', 'off'])(
    '%s: only the owner, a moderator or the service token picks the epoch',
    (variant) => {
      beforeEach(() => {
        h.variant.value = variant === 'off' ? null : variant;
      });

      // Only the callers the mode serves; a refused one is covered by the gate tests above.
      const held = (
        [
          ['a signed-out caller', anonymous],
          ['a signed-in caller with no grant', stranger],
          ['a grantee', grantee],
        ] as const
      ).filter(
        ([, caller]) =>
          (variant !== 'enforce' || caller === grantee) &&
          (variant !== 'enforce-anon' || caller !== anonymous)
      );

      it.each(held)('%s gets the no-param response whatever ?epoch= holds', async (_, caller) => {
        const unnamed = await request(caller, {}, twoEpochs);
        expect(unnamed.status).toBe(200);
        expect(unnamed.body.downloadUrls).toEqual([EPOCH_URL]);
        for (const epoch of ['5', '10', '99', '', 'latest', '5.5', ['5', '10']])
          expect(
            await request(caller, {}, twoEpochs, undefined, { epoch: epoch as string }),
            `?epoch=${JSON.stringify(epoch)}`
          ).toEqual(unnamed);
      });

      it.each([
        ['the owner', owner],
        ['a moderator', moderator],
        ['the service token', service],
      ])('%s still gets the epoch it names', async (_, caller) => {
        const { status, body, cacheControl } = await request(caller, {}, twoEpochs, undefined, {
          epoch: '5',
        });
        expect(status).toBe(200);
        expect(body.downloadUrls).toEqual([EARLY]);
        // The other modes already set it for every caller on this arm.
        if (variant === 'off') expect(cacheControl).toBe('private, no-store');
      });
    }
  );
});

/**
 * Every Private call goes through the gate, not only the epoch arm: a Private MODEL whose version
 * is Public, and a Private version whose file has no epochs.
 */
describe('mini/[id] a Private parent outside the epoch arm', () => {
  const PLAIN_FILE = {
    ...TRAINING_FILE,
    id: 405,
    visibility: 'Public',
    metadata: { format: 'SafeTensor' },
    name: 'plain.safetensors',
    hashes: { SHA256: 'E'.repeat(64) },
  };
  const shapes = [
    ['a Private model', { availability: 'Public', modelAvailability: 'Private' }],
    ['a Private version with no epochs', { availability: 'Private', modelAvailability: 'Public' }],
  ] as const;
  const otherBySession: Caller = { user: { id: STRANGER_ID } };
  const callers = [
    ['the owner', owner],
    ['a moderator', moderator],
    ['a grantee', grantee],
    ['the service token', service],
    ['an anonymous caller', anonymous],
    ['another user by OAuth', stranger],
    ['another user by session', otherBySession],
  ] as const;
  // Who is answered as an unknown id, per mode.
  const refusedIn: Record<string, string[]> = {
    off: [],
    log: [],
    enforce: ['an anonymous caller', 'another user by OAuth', 'another user by session'],
    'enforce-anon': ['an anonymous caller'],
  };
  const classOf: Record<string, string> = {
    'the owner': 'owner',
    'a moderator': 'moderator',
    'a grantee': 'grantee',
    'the service token': 'orchestrator',
    'an anonymous caller': 'anonymous',
    'another user by OAuth': 'other',
    'another user by session': 'other',
  };

  for (const [shape, row] of shapes)
    for (const mode of ['off', 'log', 'enforce', 'enforce-anon'])
      it.each(callers)(`${shape}, ${mode}: %s`, async (label, caller) => {
        h.variant.value = mode === 'off' ? null : mode;
        const result = await request(caller, row, PLAIN_FILE);
        if (refusedIn[mode].includes(label)) {
          expect(result).toEqual({
            status: 404,
            body: { error: 'Model not found' },
            cacheControl: 'private, no-store',
          });
        } else {
          expect(result.status ?? 200).toBe(200);
          expect(JSON.stringify(result.body)).toContain(PLAIN_FILE.hashes.SHA256);
        }
        if (mode === 'off') expect(callerLogs()).toEqual([]);
        else
          expect(callerLogs()).toEqual([
            expect.objectContaining({
              callerClass: classOf[label],
              payload: { isPrivate: true },
              wouldRefuse: refusedIn.enforce.includes(label),
              enforced: refusedIn[mode].includes(label),
            }),
          ]);
      });

  it('answers a refused caller exactly as an unknown id, cache header included', async () => {
    h.variant.value = 'enforce';
    const refused = await request(stranger, shapes[0][1], PLAIN_FILE);
    const unknown = await request(stranger, shapes[0][1], PLAIN_FILE, []);
    expect(refused.status).toBe(404);
    expect(refused).toEqual(unknown);
  });

  it('logs nothing for a Public version of a Public model', async () => {
    h.variant.value = 'enforce';
    const { status } = await request(anonymous, { availability: 'Public' }, PLAIN_FILE);
    expect(status ?? 200).toBe(200);
    expect(callerLogs()).toEqual([]);
  });
});

// The version status rule from #10174: only the owner, a moderator or the service token sees a hidden parent.
describe('mini/[id] a deleted or unpublished parent, whatever the gate', () => {
  const PLAIN_FILE = { ...TRAINING_FILE, visibility: 'Public', metadata: { format: 'SafeTensor' } };
  const rows = [
    ['a deleted model', { availability: 'Public', modelStatus: 'Deleted' }],
    ['an unpublished model', { availability: 'Public', modelStatus: 'Unpublished' }],
    [
      'a version released in the future',
      { availability: 'Public', publishedAt: new Date(Date.now() + 86_400_000) },
    ],
  ] as const;

  for (const [shape, row] of rows)
    for (const mode of [null, 'enforce'])
      describe(`${shape}, gate ${mode ?? 'off'}`, () => {
        beforeEach(() => {
          h.variant.value = mode;
        });
        it.each([
          ['an anonymous caller', anonymous],
          ['another user', stranger],
        ])('is an unknown id to %s', async (_label, caller) => {
          expect(await request(caller, row, PLAIN_FILE)).toMatchObject({
            status: 404,
            body: { error: 'Model not found' },
          });
        });
        it.each([
          ['the owner', owner],
          ['a moderator', moderator],
          ['the service token', service],
        ])('is served to %s', async (_label, caller) => {
          const { status, body } = await request(caller, row, PLAIN_FILE);
          expect(status ?? 200).toBe(200);
          expect(body).toHaveProperty('defaultFileId', PLAIN_FILE.id);
        });
      });

  it('answers a hidden parent exactly as an unknown id, cache header included', async () => {
    const hidden = await request(stranger, rows[0][1], PLAIN_FILE);
    const unknown = await request(stranger, rows[0][1], PLAIN_FILE, []);
    expect(hidden.status).toBe(404);
    expect(hidden.cacheControl).toBe('private, no-store');
    expect(unknown.cacheControl).toBe('private, no-store');
    expect(hidden).toEqual(unknown);
  });

  it('control: a published model is served to another user', async () => {
    const { status, body } = await request(stranger, { availability: 'Public' }, PLAIN_FILE);
    expect(status ?? 200).toBe(200);
    expect(body).toHaveProperty('defaultFileId', PLAIN_FILE.id);
  });
});

/**
 * The status rule is not behind the flag, so it must never refuse a caller the route served before:
 * the owner and the service token on a draft, unpublished or still-training version, epochs included.
 */
describe('mini/[id] unreleased versions stay served to the owner and the service token', () => {
  const PLAIN_FILE = { ...TRAINING_FILE, visibility: 'Public', metadata: { format: 'SafeTensor' } };
  const rows = [
    ['a draft version of a draft model', { status: 'Draft', modelStatus: 'Draft' }],
    ['a version still training', { status: 'Training', modelStatus: 'Training' }],
    ['a published version of a model still training', { modelStatus: 'Training' }],
    ['an unpublished version', { status: 'Unpublished', modelStatus: 'Unpublished' }],
    ['a version released in the future', { publishedAt: new Date(Date.now() + 86_400_000) }],
  ] as const;
  const servedCallers = [
    ['the owner', owner],
    ['the owner by personal API key', { ...owner, authorization: 'Bearer k', subject: 'apiKey' }],
    ['the service token', service],
  ] as const;

  for (const [shape, row] of rows)
    for (const mode of [null, 'log', 'enforce', 'enforce-anon']) {
      it.each(servedCallers)(
        `${shape}, gate ${mode ?? 'off'}: the epoch url to %s`,
        async (_l, caller) => {
          h.variant.value = mode;
          const { status, body } = await request(caller, row);
          expect(status ?? 200).toBe(200);
          expect(body.downloadUrls).toEqual([EPOCH_URL]);
        }
      );
      it.each(servedCallers)(
        `${shape}, gate ${mode ?? 'off'}: a public file to %s`,
        async (_l, caller) => {
          h.variant.value = mode;
          const { status, body } = await request(
            caller,
            { ...row, availability: 'Public' },
            PLAIN_FILE
          );
          expect(status ?? 200).toBe(200);
          expect(body).toHaveProperty('defaultFileId', PLAIN_FILE.id);
        }
      );
    }
});
