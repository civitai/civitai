import { hubFetch } from './hub';

// EXCHANGE CLIENT — redeems a cross-domain SWAP token at the hub for a civ-token. Used by a spoke's server-side
// sync handler (a different registrable domain that can't read the hub's cookie): the swap token IS the
// credential, so no cookie is forwarded. The spoke sets the returned token as its OWN cookie.
export interface ExchangeClient {
  /** Redeem a swap token for a civ-token. Null on invalid / already-used / unreachable. */
  exchange(swapToken: string): Promise<{ token: string; userId: number } | null>;
}

export function createExchangeClient(): ExchangeClient {
  return {
    async exchange(swapToken) {
      if (!swapToken) return null;
      try {
        const res = await hubFetch('/api/auth/exchange', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ swapToken }),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as { token?: string; userId?: number };
        return data.token && typeof data.userId === 'number'
          ? { token: data.token, userId: data.userId }
          : null;
      } catch {
        return null;
      }
    },
  };
}
