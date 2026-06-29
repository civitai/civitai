import path from 'path';

/**
 * Shared fixtures for the hub e2e smoke tests. NOT a test file (Playwright forbids
 * test files importing each other), so the setup + spec both import from here. It is
 * excluded from the hub config's testMatch (`hub-*.{setup,spec}.ts` only), so
 * Playwright never treats it as a test.
 *
 * Mirrors the main app's tests/preview-fixtures.ts, reusing the SAME reserved
 * `ci-smoke-*` user ids — seeded into cnpg-cluster-dev by the datapacket-talos
 * `seed-smoke-test-users` CronJob. The hub's session token is identity-only
 * (`sub`/`jti`/`signedAt`); the rich SessionUser is resolved by the hub from the DB
 * row on `GET /api/auth/identity`. So `id` is the load-bearing field here — the
 * `isModerator`/`tier` columns come from the seeded row, not the minted token.
 */

export type HubRole = 'mod' | 'tester' | 'gold';

export const HUB_USERS: Record<
  HubRole,
  { id: number; username: string; isModerator: boolean; tier?: 'gold' }
> = {
  mod: { id: 2000000001, username: 'ci-smoke-mod', isModerator: true },
  tester: { id: 2000000002, username: 'ci-smoke-tester', isModerator: false },
  gold: { id: 2000000004, username: 'ci-smoke-gold', isModerator: false, tier: 'gold' },
};

export const storageStatePath = (role: HubRole) =>
  path.join('e2e', '.auth', `hub-${role}.json`);

// Where the setup records which keypair it minted with, so the spec knows whether
// the hub will TRUST the minted token (identity assertions) or only structurally
// accept the cookie (unauth-path assertions). See hub-auth.setup.ts.
export const mintModePath = path.join('e2e', '.auth', 'mint-mode.json');

export interface MintMode {
  /** true when minted with a hub-trusted key (AUTH_JWT_* provided) → identity tests run. */
  trusted: boolean;
  kid: string;
  issuer: string;
}
