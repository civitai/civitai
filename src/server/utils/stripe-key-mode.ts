/**
 * Copies of live Stripe objects in a sandbox carry `metadata.live_id`
 * (`scripts/stripe-sandbox/sync.ts`), and the Stripe webhook copies that metadata onto the
 * Product/Price row. That makes a row's Stripe mode readable from the row, so a database shared
 * by live-key and sandbox-key readers can hold both catalogues.
 */
export const LIVE_ID_KEY = 'live_id';

export type StripeKeyMode = 'live' | 'test';

export function isTestKey(key: string | undefined) {
  return !!key && /^(sk|rk)_test_/.test(key);
}

export function stripeKeyMode(secretKey: string | undefined): StripeKeyMode {
  return isTestKey(secretKey) ? 'test' : 'live';
}

export function isSandboxCopy(metadata: unknown) {
  return !!(metadata as Record<string, unknown> | null)?.[LIVE_ID_KEY];
}

/**
 * Whether a Stripe product row belongs to the catalogue of the key in use. Rows of other
 * providers always pass. Production rows never carry `live_id`, so under a live key this hides
 * nothing there.
 */
export function inStripeKeyMode(row: { provider: string; metadata: unknown }, mode: StripeKeyMode) {
  if (row.provider !== 'Stripe') return true;
  return isSandboxCopy(row.metadata) === (mode === 'test');
}
