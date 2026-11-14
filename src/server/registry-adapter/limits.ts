/**
 * Caps on open subscriptions, shared by both bindings: one limiter is made in `main.ts` and
 * handed to the HTTP and gRPC servers, so the total counts every open stream of the process.
 *
 * Every open subscription polls on its own (`cursor.ts`, `doc-feed.ts`), so the number open is
 * what sets this process's load on the database, the document store and Redis. A subscription
 * over a cap is refused before its stream starts, with `unavailable` (HTTP 503, gRPC
 * UNAVAILABLE): the spec's "anything else", which a consumer retries with backoff. Three caps
 * apply, each checked in turn:
 *   - in total, for the process;
 *   - per token subject (a user's client), for a request with a token;
 *   - per client address (`request-origin.ts`), for every request, a token or not.
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

export type SubscriptionLimiter = {
  /**
   * Takes a slot for a subscription of `subject` (null: anonymous) from `address`, or throws
   * `unavailable` when a cap is reached. Returns the function that frees it; a second call does
   * nothing.
   */
  acquire(who: { subject: string | null; address: string }): () => void;
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
    acquire({ subject, address }) {
      if (total >= limits.total) throw refuse('on this source');
      if (subject !== null && (bySubject.get(subject) ?? 0) >= limits.perSubject) {
        throw refuse('for this token');
      }
      if ((byAddress.get(address) ?? 0) >= limits.perAddress) throw refuse('from this address');
      total++;
      if (subject !== null) take(bySubject, subject);
      take(byAddress, address);
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        total--;
        if (subject !== null) give(bySubject, subject);
        give(byAddress, address);
      };
    },
    open: () => total,
  };
}
