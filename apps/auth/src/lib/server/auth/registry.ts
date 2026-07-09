import {
  createSessionRegistry,
  type SessionRegistry,
  type SessionRegistryRedis,
} from '@civitai/auth';
import { REDIS_KEYS, REDIS_SYS_KEYS } from '@civitai/redis';
import { getSysRedis } from '../redis';

// Cross-app session revocation. The redis CLIENT is built from @civitai/redis; the KEY STRINGS
// come from @civitai/redis's registry — so a logout/ban here is seen by every app on the same
// redis, with no second definition to collide.
//
// Falls back to a no-op registry when REDIS isn't configured, so the hub still runs (login works;
// tracking/revocation are simply skipped) — the same fail-open spirit as the main app.

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

// Built lazily on FIRST USE (a request), never at module-load — so `vite build` (which evaluates
// modules but calls no methods) doesn't try to read REDIS_* / connect.
let _registry: SessionRegistry | undefined;
function registry(): SessionRegistry {
  if (_registry) return _registry;
  const sysRedis = getSysRedis(); // the hub's single shared sys client (null when REDIS_SYS_URL is unset)
  if (!sysRedis) return (_registry = noop);
  return (_registry = createSessionRegistry({
    // sysRedis's methods are typed to the known-key union; the registry is namespace-agnostic
    // (plain string keys), so cast at this boundary — the main app does the same on these calls.
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
