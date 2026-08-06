import { REDIS_KEYS, REDIS_SYS_KEYS } from '@civitai/redis';
import type { SessionKeys } from './session-registry';

// The canonical mapping, assembled once. `session-registry.ts` stays infra-free and takes keys as
// injection; this module is the one place that says WHICH keys — three apps had hand-copied the same
// three lines, and a divergence there does not fail loudly: `invalidateUserSessions` would resolve
// against the wrong hash, report success, and leave a banned or muted user's sessions alive.
export const SESSION_REGISTRY_KEYS: SessionKeys = {
  tokenState: REDIS_SYS_KEYS.SESSION.TOKEN_STATE,
  all: REDIS_SYS_KEYS.SESSION.ALL,
  userTokens: REDIS_KEYS.SESSION.USER_TOKENS,
};
