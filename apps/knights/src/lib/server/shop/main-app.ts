import { env } from '$env/dynamic/private';
import { MAIN_APP_TIMEOUT_MS } from './config';

/** The main app answered 409: it refused this request for good, and a retry would be refused again. */
export class MainAppRejectedError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    /** The main app's own wording of the refusal, fit to show a player. */
    readonly detail = ''
  ) {
    super(`The main app refused the request: ${status} ${reason}`);
    this.name = 'MainAppRejectedError';
  }
}

export type MembershipGrant = {
  userId: number;
  tier: string;
  /** Idempotency key: the main app grants one membership month per key. */
  key: string;
};

export type MainAppPort = {
  grantMembership(grant: MembershipGrant): Promise<{ outcome: 'granted' | 'already' }>;
  /** Busts the main app's cosmetic caches after Knights inserted a `UserCosmetic`. */
  refreshCosmetics(userId: number): Promise<void>;
  /** Equips through the main app's own `equipCosmetic`, so its rules, caches and worn-cosmetic queue run. */
  equipCosmetic(userId: number, cosmeticId: number): Promise<void>;
  unequipCosmetic(userId: number, cosmeticId: number): Promise<void>;
};

const trimSlash = (value: string) => (value.endsWith('/') ? value.slice(0, -1) : value);

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
      // Only a 409 is the endpoint's own final answer. Any other status (a 401 from a mismatched token, a 404 from a deploy
      // that went out of order) says nothing about whether an earlier try was granted, so it stays retryable.
      if (res.status === 409) {
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
