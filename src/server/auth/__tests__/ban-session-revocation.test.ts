import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionClaims } from '@civitai/auth';

// End-to-end revocation property (the coverage gap behind review finding B2): a banned/logged-out user's
// active civ-token must stop verifying. The chain spans two modules that share sysRedis:
//   hub mint  → trackToken(jti, userId)            (records jti in USER_TOKENS:{userId})   [seeded here]
//   ban       → invalidateSession(userId)          (marks TOKEN_STATE[jti] = 'invalid')    [session-invalidation]
//   request   → isRevoked({ jti })                 (TOKEN_STATE[jti] === 'invalid' → true) [session-verifier]
// sysRedis is an in-memory store shared by both modules, so we exercise the real chain end-to-end.

const h = vi.hoisted(() => {
  const hashes = new Map<string, Map<string, string>>();
  const strings = new Map<string, string>();
  const KEYS = {
    REDIS_KEYS: {
      SESSION: { USER_TOKENS: 'session:usertokens' },
      USER: { SESSION: 'user:session' }, // invalidateAllSessions clears this pattern
    },
    REDIS_SYS_KEYS: {
      SESSION: { TOKEN_STATE: 'session:tokenstate', ALL: 'session:all', REFRESH_CAUSE: 'session:refreshcause' },
    },
  };
  const sysRedis = {
    hGetAll: async (k: string) => Object.fromEntries(hashes.get(k) ?? new Map<string, string>()),
    hSet: async (k: string, obj: Record<string, string>) => {
      const m = hashes.get(k) ?? new Map<string, string>();
      for (const [f, v] of Object.entries(obj)) m.set(f, v);
      hashes.set(k, m);
    },
    hExpire: async () => {},
    hGet: async (k: string, f: string) => hashes.get(k)?.get(f) ?? null,
    get: async (k: string) => strings.get(k) ?? null,
    set: async (k: string, v: string) => {
      strings.set(k, v);
    },
  };
  return { hashes, strings, KEYS, sysRedis };
});

vi.mock('~/server/redis/client', () => ({ sysRedis: h.sysRedis, ...h.KEYS }));
// session-invalidation marks TOKEN_STATE via the atomic eval helper (hSetMultiWithTTL); the
// fake sysRedis above has no `eval`, so stub the helper to write straight to the in-memory hash.
vi.mock('~/server/redis/atomic', () => ({
  hSetWithTTL: async (_c: unknown, key: string, field: string, value: string | number) => {
    const m = h.hashes.get(key) ?? new Map<string, string>();
    m.set(field, String(value));
    h.hashes.set(key, m);
  },
  hSetMultiWithTTL: async (
    _c: unknown,
    key: string,
    fields: Record<string, string | number>
  ) => {
    const m = h.hashes.get(key) ?? new Map<string, string>();
    for (const [f, v] of Object.entries(fields)) m.set(f, String(v));
    h.hashes.set(key, m);
  },
}));
vi.mock('~/server/utils/cache-helpers', () => ({ clearCacheByPattern: async () => {} }));
vi.mock('~/server/auth/session-cache', () => ({ clearSessionCache: async () => {} }));
vi.mock('~/utils/signal-client', () => ({ signalClient: { send: async () => {} } }));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: () => {} }));
vi.mock('~/utils/logging', () => ({ createLogger: () => () => {} }));
vi.mock('~/server/common/enums', () => ({ SignalMessages: { SessionRefresh: 'session:refresh' } }));
// session-verifier constructs an AuthVerifier at module load — stub it (we only exercise isRevoked).
vi.mock('@civitai/auth', () => ({ createAuthVerifier: () => ({}) }));
// The global unit setup (src/__tests__/setup.ts) mocks session-invalidation to a stub; we need the REAL
// module here to exercise the actual ban→revoke chain against our in-memory sysRedis.
vi.unmock('~/server/auth/session-invalidation');

import {
  invalidateSession,
  invalidateAllSessions,
  refreshSession,
} from '~/server/auth/session-invalidation';
import { isRevoked } from '~/server/auth/session-verifier';

const USER = 5;
const TOKEN_STATE = h.KEYS.REDIS_SYS_KEYS.SESSION.TOKEN_STATE;
const claims = (jti: string, signedAt = 1000): SessionClaims => ({ jti, signedAt });

// Mirror the hub's sessions.trackToken (session.ts): record the token's jti under the user's token hash.
function trackToken(jti: string, userId: number) {
  const key = `${h.KEYS.REDIS_KEYS.SESSION.USER_TOKENS}:${userId}`;
  const m = h.hashes.get(key) ?? new Map<string, string>();
  m.set(jti, '1');
  h.hashes.set(key, m);
}

beforeEach(() => {
  h.hashes.clear();
  h.strings.clear();
});

describe('ban / logout session revocation (B2 coverage)', () => {
  it('revokes a tracked token after invalidateSession (ban path)', async () => {
    trackToken('tok-1', USER);
    expect(await isRevoked(claims('tok-1'))).toBe(false); // not yet banned

    await invalidateSession(USER);

    // marker written to the SAME hash the verifier reads, keyed by jti
    expect(h.hashes.get(TOKEN_STATE)?.get('tok-1')).toBe('invalid');
    expect(await isRevoked(claims('tok-1'))).toBe(true);
  });

  it('revokes ALL of a user’s tracked tokens at once', async () => {
    trackToken('tok-a', USER);
    trackToken('tok-b', USER);

    await invalidateSession(USER);

    expect(await isRevoked(claims('tok-a'))).toBe(true);
    expect(await isRevoked(claims('tok-b'))).toBe(true);
  });

  it('does not revoke a different user’s token', async () => {
    trackToken('mine', USER);
    trackToken('theirs', 999);

    await invalidateSession(USER); // ban USER only

    expect(await isRevoked(claims('mine'))).toBe(true);
    expect(await isRevoked(claims('theirs'))).toBe(false);
  });

  it('global invalidateAllSessions revokes tokens signed before the cutoff, not after', async () => {
    await invalidateAllSessions(new Date(5000));

    expect(await isRevoked(claims('old', 4000))).toBe(true); // signed before the cutoff
    expect(await isRevoked(claims('new', 6000))).toBe(false); // signed after
  });

  it('fails open (not revoked) when the token carries no jti', async () => {
    expect(await isRevoked(claims('', 1000))).toBe(false);
    expect(await isRevoked({ signedAt: 1000 })).toBe(false);
  });

  // refresh and invalid share the SAME TOKEN_STATE hash; only 'invalid' may revoke. A regression where
  // isRevoked treated any non-null state as revoked would log out every active user on a benign refresh.
  it('a refresh-marked token is NOT revoked (only invalid revokes)', async () => {
    trackToken('tok-refresh', USER);

    await refreshSession(USER, { sendSignal: false });

    // the marker landed in the shared hash, but as 'refresh' — not a revocation
    expect(h.hashes.get(TOKEN_STATE)?.get('tok-refresh')).toBe('refresh');
    expect(await isRevoked(claims('tok-refresh'))).toBe(false);
  });

  // The shared-hash invariant from both directions: a later invalidate must override an earlier refresh.
  it('invalidate after refresh still revokes (invalid wins on the same jti)', async () => {
    trackToken('tok-x', USER);

    await refreshSession(USER, { sendSignal: false });
    expect(await isRevoked(claims('tok-x'))).toBe(false);

    await invalidateSession(USER);
    expect(h.hashes.get(TOKEN_STATE)?.get('tok-x')).toBe('invalid');
    expect(await isRevoked(claims('tok-x'))).toBe(true);
  });
});
