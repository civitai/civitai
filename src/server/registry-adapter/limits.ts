/**
 * Caps on open subscriptions, shared by both bindings: one limiter is made in `main.ts` and
 * handed to the HTTP and gRPC servers, so the total counts every open stream of the process.
 *
 * Every open subscription polls on its own (`cursor.ts`, `doc-feed.ts`), so the number open is
 * what sets this process's load on the database, the document store and Redis. A subscription
 * over a cap is refused before its stream starts, with `unavailable` (HTTP 503, gRPC
 * UNAVAILABLE): the spec's "anything else", which a consumer retries with backoff. Three caps
 * apply:
 *   - in total, for the process, and per client address (`request-origin.ts`), for every
 *     request, a token or not: both checked before the token is verified, so a request over
 *     either costs no token lookup;
 *   - per token subject (a user's client), for a request with a token, once it is verified.
 * A slot is held until the subscription's stream ends, however it ends, and freed once.
 */
import { ProtocolError } from '~/server/registry-adapter/protocol';

export type SubscriptionLimits = {
  /** Open subscriptions in the process. */
  total: number;
  /** Open subscriptions per token subject. */
  perSubject: number;
  /** Open subscriptions per client address. */
  perAddress: number;
};

export const DEFAULT_SUBSCRIPTION_LIMITS: SubscriptionLimits = {
  total: 2000,
  perSubject: 100,
  perAddress: 100,
};

/** The environment variable that overrides each cap. */
export const SUBSCRIPTION_LIMIT_ENV: Record<keyof SubscriptionLimits, string> = {
  total: 'REGISTRY_ADAPTER_MAX_SUBSCRIPTIONS',
  perSubject: 'REGISTRY_ADAPTER_MAX_SUBSCRIPTIONS_PER_TOKEN',
  perAddress: 'REGISTRY_ADAPTER_MAX_SUBSCRIPTIONS_PER_ADDRESS',
};

/**
 * The caps from `env`: each variable unset or empty is its default; anything but a positive
 * integer throws, so a misconfigured process does not start.
 */
export function subscriptionLimitsFromEnv(
  env: Record<string, string | undefined>
): SubscriptionLimits {
  const read = (key: keyof SubscriptionLimits) => {
    const name = SUBSCRIPTION_LIMIT_ENV[key];
    const raw = env[name];
    if (raw === undefined || raw === '') return DEFAULT_SUBSCRIPTION_LIMITS[key];
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
    return n;
  };
  return { total: read('total'), perSubject: read('perSubject'), perAddress: read('perAddress') };
}

/** One subscription's slot: held from {@link SubscriptionLimiter.acquire} until `release`. */
export type SubscriptionSlot = {
  /**
   * Counts the slot against `subject`, the token's (null: anonymous, which counts against none),
   * or throws `unavailable` when that token is at its cap. Called once, after the token is
   * verified; the caller still releases the slot when it throws.
   */
  claim(subject: string | null): void;
  /** Frees the slot, and its token's count if claimed; a second call does nothing. */
  release(): void;
};

export type SubscriptionLimiter = {
  /**
   * Takes a slot for a subscription from `address`, or throws `unavailable` when the total or
   * that address is at its cap. Called before the token is verified, so a refused request costs
   * no token lookup.
   */
  acquire(address: string): SubscriptionSlot;
  /** Subscriptions holding a slot now. */
  open(): number;
};

export function createSubscriptionLimiter(limits: SubscriptionLimits): SubscriptionLimiter {
  let total = 0;
  const bySubject = new Map<string, number>();
  const byAddress = new Map<string, number>();
  const take = (counts: Map<string, number>, key: string) =>
    counts.set(key, (counts.get(key) ?? 0) + 1);
  const give = (counts: Map<string, number>, key: string) => {
    const n = (counts.get(key) ?? 0) - 1;
    if (n > 0) counts.set(key, n);
    else counts.delete(key);
  };
  const refuse = (what: string) =>
    new ProtocolError('unavailable', `too many open subscriptions ${what}; retry later`);

  return {
    acquire(address) {
      if (total >= limits.total) throw refuse('on this source');
      if ((byAddress.get(address) ?? 0) >= limits.perAddress) throw refuse('from this address');
      total++;
      take(byAddress, address);
      let held = true;
      let claimed: string | null = null;
      return {
        claim(subject) {
          if (!held || claimed !== null || subject === null) return;
          if ((bySubject.get(subject) ?? 0) >= limits.perSubject) throw refuse('for this token');
          take(bySubject, subject);
          claimed = subject;
        },
        release() {
          if (!held) return;
          held = false;
          total--;
          give(byAddress, address);
          if (claimed !== null) give(bySubject, claimed);
        },
      };
    },
    open: () => total,
  };
}
