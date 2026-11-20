import { describe, expect, it } from 'vitest';
import type { BuzzSpendEntry } from '~/server/http/orchestrator/api-key-spend';
import {
  OFFLINE_BUZZ_CAP_REACHED,
  resolveOfflineCapToken,
  type OfflineCapReads,
  type OfflineCapRequest,
} from '~/server/orchestrator/offline-spend-cap';
import { ApiKeyType } from '~/shared/utils/prisma/enums';

// The offline Buzz cap: a refresh-minted OAuth token (no user present) whose consent carries a cap
// goes to the orchestrator as itself, metered under the app's subject against that cap, and is
// refused here once the orchestrator reports the cap spent. Everything else gets null, which leaves
// getOrchestratorToken as before.

const USER = 4242;
const CAP = [{ type: 'sliding' as const, limit: 500, window: 'day' as const, unit: 1 }];
const BEARER = 'civitai_app-token-value';

function request(over: Partial<OfflineCapRequest> = {}): OfflineCapRequest {
  return {
    userId: USER,
    credential: {
      subject: { type: 'oauth', id: 'offline-app' },
      apiKeyId: 9,
      apiKeyType: ApiKeyType.Access,
    },
    sessionUserId: USER,
    buzzLimit: CAP,
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

function reads(over: Partial<OfflineCapReads> & { origin?: string | null } = {}) {
  const calls = { flag: 0, origin: [] as number[], spend: 0 };
  const r: OfflineCapReads = {
    flagOn: async () => {
      calls.flag++;
      return true;
    },
    mintOrigin: async (id) => {
      calls.origin.push(id);
      return 'origin' in over ? over.origin ?? null : 'refresh';
    },
    spend: async () => {
      calls.spend++;
      return spendEntry(120);
    },
    ...over,
  };
  return { r, calls };
}

describe('the offline Buzz cap', () => {
  it('sends a refresh-minted token with a cap to the orchestrator as itself, with budget left', async () => {
    const { r, calls } = reads();
    await expect(resolveOfflineCapToken(request(), r)).resolves.toBe(BEARER);
    expect(calls.origin).toEqual([9]);
  });

  it('refuses with a clear error once the orchestrator reports the cap spent', async () => {
    const { r } = reads({ spend: async () => spendEntry(0) });
    await expect(resolveOfflineCapToken(request(), r)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: OFFLINE_BUZZ_CAP_REACHED,
    });
  });

  it('still sends the token when the orchestrator snapshot cannot be read (it enforces the cap itself)', async () => {
    const { r } = reads({ spend: async () => Promise.reject(new Error('orchestrator down')) });
    await expect(resolveOfflineCapToken(request(), r)).resolves.toBe(BEARER);
  });

  it.each(['auth_code', 'app_token', 'device_code', null])(
    'leaves a token minted as %s alone',
    async (origin) => {
      const { r } = reads({ origin });
      await expect(resolveOfflineCapToken(request(), r)).resolves.toBeNull();
    }
  );

  it.each([
    ['no cap (null)', { buzzLimit: null }],
    ['no cap (empty)', { buzzLimit: [] }],
    [
      'a personal API key',
      {
        credential: {
          subject: { type: 'apiKey' as const, id: 3 },
          apiKeyId: 3,
          apiKeyType: ApiKeyType.User,
        },
      },
    ],
    ['a moderator fetching another user’s token', { sessionUserId: 1 }],
  ])('changes nothing for %s, and reads neither Flipt nor the key', async (_, over) => {
    const { r, calls } = reads();
    await expect(resolveOfflineCapToken(request(over), r)).resolves.toBeNull();
    expect(calls).toEqual({ flag: 0, origin: [], spend: 0 });
  });

  it('changes nothing with the flag off, and never reads the mint origin', async () => {
    const { r, calls } = reads({ flagOn: async () => false });
    await expect(resolveOfflineCapToken(request(), r)).resolves.toBeNull();
    expect(calls.origin).toEqual([]);
  });
});
