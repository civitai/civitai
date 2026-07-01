// Cross-app session revocation (spoke side). Mirrors apps/auth/src/lib/server/auth/registry.ts. The redis
// CLIENT is built from @civitai/redis; the KEY STRINGS come from @civitai/redis's registry — so a
// logout/ban done anywhere is seen here, with no second key definition to collide.
//
// Falls back to a no-op registry when sysRedis isn't configured, so the service still runs (revocation is
// simply skipped) — the same fail-open spirit as the hub + the main app.

import {
  createSessionRegistry,
  type SessionRegistry,
  type SessionRegistryRedis,
} from '@civitai/auth';
import { REDIS_KEYS, REDIS_SYS_KEYS } from '@civitai/redis';
import { getSysRedis } from '../clients/redis';

const noop: SessionRegistry = {
  async trackToken() {},
  async invalidateToken() {},
  async invalidateUserSessions() {},
  async invalidateAll() {},
  async markForRefresh() {},
  async isRevoked() {
    return false;
  },
};

// Built lazily on FIRST USE (a request), never at module-load — so the bundler/build (which evaluates
// modules but calls no methods) doesn't try to read REDIS_* / connect.
let _registry: SessionRegistry | undefined;
function registry(): SessionRegistry {
  if (_registry) return _registry;
  const sysRedis = getSysRedis(); // the service's single shared sys client (null when REDIS_SYS_URL is unset)
  if (!sysRedis) return (_registry = noop);
  return (_registry = createSessionRegistry({
    // sysRedis's methods are typed to the known-key union; the registry is namespace-agnostic (plain
    // string keys), so cast at this boundary — the hub + main app do the same on these calls.
    redis: sysRedis as unknown as SessionRegistryRedis,
    keys: {
      tokenState: REDIS_SYS_KEYS.SESSION.TOKEN_STATE,
      all: REDIS_SYS_KEYS.SESSION.ALL,
      userTokens: REDIS_KEYS.SESSION.USER_TOKENS,
    },
  }));
}

// Lazy facade delegating to the real (or no-op) registry on first call.
export const sessions: SessionRegistry = {
  trackToken: (tokenId, userId) => registry().trackToken(tokenId, userId),
  invalidateToken: (tokenId, userId) => registry().invalidateToken(tokenId, userId),
  invalidateUserSessions: (userId) => registry().invalidateUserSessions(userId),
  invalidateAll: () => registry().invalidateAll(),
  markForRefresh: (tokenId) => registry().markForRefresh(tokenId),
  isRevoked: (claims) => registry().isRevoked(claims),
};
