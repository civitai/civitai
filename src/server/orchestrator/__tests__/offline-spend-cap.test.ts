import { describe, expect, it } from 'vitest';
import type { BuzzSpendEntry } from '~/server/http/orchestrator/api-key-spend';
import { OFFLINE_BUZZ_CAP_REACHED } from '~/server/orchestrator/api-key-buzz-limit-refusal';
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
// getOrchestratorToken on the System token. The OAuth case is refused here once the orchestrator's
// snapshot shows its cap spent; a personal key is never checked here (the orchestrator enforces it).

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

function spendEntry(remaining: number): BuzzSpendEntry {
  return {
    type: 'oauth',
    id: 'offline-app',
    spend: 500 - remaining,
    rules: [
      { type: 'sliding', limit: 500, spend: 500 - remaining, remaining, window: 'day', unit: 1 },
    ],
    buckets: [],
  };
}

function reads(
  over: {
    offlineGrant?: boolean;
    userKey?: boolean;
    origin?: string | null;
    spend?: () => Promise<BuzzSpendEntry | null>;
  } = {}
) {
  const calls = { offlineGrantFlag: 0, userKeyFlag: 0, origin: [] as number[], spend: 0 };
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
    spend: async () => {
      calls.spend++;
      return over.spend ? over.spend() : spendEntry(120);
    },
  };
  return { r, calls };
}

describe('a refresh-minted OAuth token with a cap', () => {
  it('is sent as itself, with budget left', async () => {
    const { r, calls } = reads();
    await expect(resolveOwnKeyToken(request(), r)).resolves.toBe(BEARER);
    expect(calls.origin).toEqual([9]);
    expect(calls.spend).toBe(1);
  });

  it('is refused with a clear error once the orchestrator reports the cap spent', async () => {
    const { r } = reads({ spend: async () => spendEntry(0) });
    await expect(resolveOwnKeyToken(request(), r)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: OFFLINE_BUZZ_CAP_REACHED,
    });
  });

  it('is still sent when the snapshot cannot be read (the orchestrator enforces the cap itself)', async () => {
    const { r } = reads({ spend: () => Promise.reject(new Error('orchestrator down')) });
    await expect(resolveOwnKeyToken(request(), r)).resolves.toBe(BEARER);
  });

  it.each(['auth_code', 'app_token', 'device_code', null])(
    'is left alone when minted as %s',
    async (origin) => {
      const { r } = reads({ origin });
      await expect(resolveOwnKeyToken(request(), r)).resolves.toBeNull();
    }
  );

  it('is left alone with its flag off, even with the personal-key flag on and its cap spent', async () => {
    const { r, calls } = reads({
      offlineGrant: false,
      userKey: true,
      spend: async () => spendEntry(0),
    });
    await expect(resolveOwnKeyToken(request(), r)).resolves.toBeNull();
    expect(calls).toMatchObject({ origin: [], spend: 0, userKeyFlag: 0 });
  });
});

describe('a personal API key with a Buzz limit', () => {
  it('is sent as itself even with its budget spent, reading neither the spend nor the mint origin', async () => {
    const { r, calls } = reads({ spend: async () => spendEntry(0) });
    await expect(resolveOwnKeyToken(request({ credential: personal }), r)).resolves.toBe(BEARER);
    expect(calls).toEqual({ offlineGrantFlag: 0, userKeyFlag: 1, origin: [], spend: 0 });
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
    expect(calls).toEqual({ offlineGrantFlag: 0, userKeyFlag: 0, origin: [], spend: 0 });
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
