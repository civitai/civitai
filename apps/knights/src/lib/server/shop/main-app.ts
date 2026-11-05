import { env } from '$env/dynamic/private';
import { MAIN_APP_TIMEOUT_MS } from './config';

/** The main app definitively refused: a retry would be refused again (a 4xx other than 408 or 429). */
export class MainAppRejectedError extends Error {
  constructor(readonly status: number, readonly reason: string) {
    super(`The main app refused the request: ${status} ${reason}`);
    this.name = 'MainAppRejectedError';
  }
}

export type MembershipGrant = {
  userId: number;
  tier: string;
  months: number;
  /** Idempotency key: the main app grants one membership per key. */
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

const TRANSIENT = new Set([408, 429]);

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
      if (res.status >= 400 && res.status < 500 && !TRANSIENT.has(res.status)) {
        throw new MainAppRejectedError(res.status, String(answer?.reason ?? answer?.error ?? ''));
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

/** Wired from env; a missing `WEBHOOK_TOKEN` throws on first use, not at boot. */
let port: MainAppPort | undefined;
export function getMainAppPort(): MainAppPort {
  if (!port) {
    const token = env.WEBHOOK_TOKEN;
    if (!token) throw new Error('WEBHOOK_TOKEN is not configured');
    port = mainAppPort({ baseUrl: env.CIVITAI_APP_URL || 'https://civitai.com', token });
  }
  return port;
}
