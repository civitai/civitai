import { describe, expect, it } from 'vitest';
import {
  readMintOrigin,
  resolveOwnKeyToken,
  type OwnKeyReads,
  type OwnKeyRequest,
} from '~/server/orchestrator/offline-spend-cap';
import { ApiKeyType } from '~/shared/utils/prisma/enums';

// Which requests reach the orchestrator as their own limited key: a refresh-minted OAuth token whose
// consent has a cap (flag `oauth-offline-grant`), or a personal API key with a Buzz limit used by its
// own user (flag `user-key-buzz-limit-proxy`). Everything else gets null, which leaves
// getOrchestratorToken on the System token. Neither case reads its spend here: the orchestrator holds
// the key to its limit and answers an over-limit call itself.

const USER = 4242;
const LIMIT = [{ type: 'sliding' as const, limit: 500, window: 'day' as const, unit: 1 }];
const BEARER = 'civitai_caller-token-value';

const oauth = {
  subject: { type: 'oauth' as const, id: 'offline-app' },
  apiKeyId: 9,
  apiKeyType: ApiKeyType.Access,
};
const personal = {
  subject: { type: 'apiKey' as const, id: 3 },
  apiKeyId: 3,
  apiKeyType: ApiKeyType.User,
};

function request(over: Partial<OwnKeyRequest> = {}): OwnKeyRequest {
  return {
    userId: USER,
    credential: oauth,
    sessionUserId: USER,
    buzzLimit: LIMIT,
    bearerToken: () => BEARER,
    ...over,
  };
}

function reads(
  over: {
    offlineGrant?: boolean;
    userKey?: boolean;
    origin?: string | null;
  } = {}
) {
  const calls = { offlineGrantFlag: 0, userKeyFlag: 0, origin: [] as number[] };
  const r: OwnKeyReads = {
    offlineGrantFlagOn: async () => {
      calls.offlineGrantFlag++;
      return over.offlineGrant ?? true;
    },
    userKeyFlagOn: async () => {
      calls.userKeyFlag++;
      return over.userKey ?? true;
    },
    mintOrigin: async (id) => {
      calls.origin.push(id);
      return 'origin' in over ? over.origin ?? null : 'refresh';
    },
  };
  return { r, calls };
}

describe('a refresh-minted OAuth token with a cap', () => {
  it('is sent as itself, without reading its spend', async () => {
    const { r, calls } = reads();
    await expect(resolveOwnKeyToken(request(), r)).resolves.toBe(BEARER);
    expect(calls).toEqual({ offlineGrantFlag: 1, userKeyFlag: 0, origin: [9] });
  });

  it.each(['auth_code', 'app_token', 'device_code', null])(
    'is left alone when minted as %s',
    async (origin) => {
      const { r } = reads({ origin });
      await expect(resolveOwnKeyToken(request(), r)).resolves.toBeNull();
    }
  );

  it('is left alone with its flag off, even with the personal-key flag on', async () => {
    const { r, calls } = reads({ offlineGrant: false, userKey: true });
    await expect(resolveOwnKeyToken(request(), r)).resolves.toBeNull();
    expect(calls).toMatchObject({ origin: [], userKeyFlag: 0 });
  });
});

describe('a personal API key with a Buzz limit', () => {
  it('is sent as itself without reading the mint origin', async () => {
    const { r, calls } = reads();
    await expect(resolveOwnKeyToken(request({ credential: personal }), r)).resolves.toBe(BEARER);
    expect(calls).toEqual({ offlineGrantFlag: 0, userKeyFlag: 1, origin: [] });
  });

  it('is left alone with its flag off, even with the offline-grant flag on', async () => {
    const { r } = reads({ userKey: false, offlineGrant: true });
    await expect(resolveOwnKeyToken(request({ credential: personal }), r)).resolves.toBeNull();
  });

  it('is left alone when it is a System key', async () => {
    const { r } = reads();
    const system = { ...personal, apiKeyType: ApiKeyType.System };
    await expect(resolveOwnKeyToken(request({ credential: system }), r)).resolves.toBeNull();
  });
});

describe.each([
  ['an OAuth token', oauth],
  ['a personal key', personal],
])('%s changes nothing, reading neither Flipt nor the key, for', (_, credential) => {
  it.each([
    ['no limit (null)', { buzzLimit: null }],
    ['no limit (empty)', { buzzLimit: [] }],
    ['a moderator fetching another user’s token', { sessionUserId: 1 }],
    ['no bearer token on the request', { bearerToken: () => undefined }],
  ])('%s', async (_, over) => {
    const { r, calls } = reads();
    await expect(resolveOwnKeyToken(request({ credential, ...over }), r)).resolves.toBeNull();
    expect(calls).toEqual({ offlineGrantFlag: 0, userKeyFlag: 0, origin: [] });
  });
});

describe('reading the mint origin', () => {
  // A query builder whose terminal call yields `result`, or throws `error`.
  const executor = (outcome: { row?: unknown; error?: unknown }) => {
    const qb = {
      select: () => qb,
      where: () => qb,
      executeTakeFirst: async () => {
        if (outcome.error) throw outcome.error;
        return outcome.row;
      },
    };
    return { selectFrom: () => qb } as unknown as Parameters<typeof readMintOrigin>[1];
  };

  it('returns the recorded origin (positive control)', async () => {
    await expect(readMintOrigin(9, executor({ row: { mintOrigin: 'refresh' } }))).resolves.toBe(
      'refresh'
    );
  });

  it('reads as no origin when the column does not exist yet (flag on before the migration)', async () => {
    const missing = Object.assign(new Error('column "mintOrigin" does not exist'), {
      code: '42703',
    });
    await expect(readMintOrigin(9, executor({ error: missing }))).resolves.toBeNull();
  });

  it('throws any other database error', async () => {
    const down = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    await expect(readMintOrigin(9, executor({ error: down }))).rejects.toBe(down);
  });
});
