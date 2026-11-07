import { env } from '$env/dynamic/private';
import { MAIN_APP_TIMEOUT_MS } from './config';

/** The main app answered a 4xx other than 408 and 429: it refused this request for good, and a retry would be refused again. */
export class MainAppRejectedError extends Error {
  constructor(readonly status: number, readonly reason: string, readonly detail = '') {
    super(`The main app refused the request: ${status} ${reason}`);
    this.name = 'MainAppRejectedError';
  }
}

export type MembershipGrant = {
  userId: number;
  tier: string;
  /** Length of the membership; the main app grants one month when it is absent. */
  days?: number;
  /** Idempotency key: the main app grants one membership per key. */
  key: string;
};

export type MainAppPort = {
  grantMembership(grant: MembershipGrant): Promise<{ outcome: 'granted' | 'already' }>;
  refreshCosmetics(userId: number): Promise<void>;
  /** Equips through the main app's own `equipCosmetic`, so its rules, caches and worn-cosmetic queue run. */
  equipCosmetic(userId: number, cosmeticId: number): Promise<void>;
  unequipCosmetic(userId: number, cosmeticId: number): Promise<void>;
};

const trimSlash = (value: string) => (value.endsWith('/') ? value.slice(0, -1) : value);

/**
 * Only answers the endpoint itself gives are final: a 409 comes after its replay check, and a 400 or 422 refuses the
 * same body every time. A 401, 403 or 404 is answered before the endpoint runs (token, edge, route), so it says
 * nothing about an earlier try that may have granted the membership, and stays retryable.
 */
const FINAL_STATUSES = new Set([400, 409, 422]);

type Fetch = typeof fetch;

export function mainAppPort(
  { baseUrl, token }: { baseUrl: string; token: string },
  fetcher: Fetch = fetch
): MainAppPort {
  async function post(path: string, body: Record<string, unknown>) {
    const res = await fetcher(`${trimSlash(baseUrl)}/api/mod/knights/shop/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-token': token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(MAIN_APP_TIMEOUT_MS),
    });
    const answer = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      if (FINAL_STATUSES.has(res.status)) {
        throw new MainAppRejectedError(
          res.status,
          String(answer?.reason ?? ''),
          typeof answer?.error === 'string' ? answer.error : ''
        );
      }
      throw new Error(`main app answered ${res.status}`);
    }
    return answer ?? {};
  }
  return {
    async grantMembership(grant) {
      const answer = await post('membership', grant);
      if (answer.outcome === 'granted' || answer.outcome === 'already') {
        return { outcome: answer.outcome };
      }
      throw new Error('main app answered with an outcome this app does not know');
    },
    async refreshCosmetics(userId) {
      await post('cosmetics', { action: 'refresh', userId });
    },
    async equipCosmetic(userId, cosmeticId) {
      await post('cosmetics', { action: 'equip', userId, cosmeticId });
    },
    async unequipCosmetic(userId, cosmeticId) {
      await post('cosmetics', { action: 'unequip', userId, cosmeticId });
    },
  };
}

let port: MainAppPort | undefined;
function resolve(): MainAppPort {
  if (!port) {
    const token = env.WEBHOOK_TOKEN;
    if (!token) throw new Error('WEBHOOK_TOKEN is not configured');
    port = mainAppPort({ baseUrl: env.CIVITAI_APP_URL || 'https://civitai.com', token });
  }
  return port;
}

const wired: MainAppPort = {
  grantMembership: async (grant) => resolve().grantMembership(grant),
  refreshCosmetics: async (userId) => resolve().refreshCosmetics(userId),
  equipCosmetic: async (userId, cosmeticId) => resolve().equipCosmetic(userId, cosmeticId),
  unequipCosmetic: async (userId, cosmeticId) => resolve().unequipCosmetic(userId, cosmeticId),
};

/** A missing `WEBHOOK_TOKEN` throws on the first main-app call, not at boot or on a Buzz-pack purchase. */
export const getMainAppPort = (): MainAppPort => wired;
