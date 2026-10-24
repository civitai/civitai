/**
 * Every lifetime `BlockTokenService.sign` can stamp, in one place.
 *
 * Controls that have to OUTLAST a token — the revocation marker's TTL,
 * key-rotation overlap, the verifier's per-type max-age cap — need the worst
 * case, and restating it as a number is what let the revocation TTL sit at
 * 15min for the whole time dev:live tokens lived 4h. Derive from
 * `MAX_BLOCK_TOKEN_LIFETIME_SECONDS` so a new kind added here raises them too.
 *
 * A new lifetime therefore belongs in this record, not beside its call site.
 */
export const BLOCK_TOKEN_LIFETIMES_SECONDS = {
  default: 900,
  /** block:settings:* — tightest replay window (M-4 / audit-9 #3) */
  settings: 300,
  /** dev:live pasted tokens — mod-only, self-bound, budget-capped */
  dev: 4 * 60 * 60,
} as const;

export const MAX_BLOCK_TOKEN_LIFETIME_SECONDS = Math.max(
  ...Object.values(BLOCK_TOKEN_LIFETIMES_SECONDS)
);
