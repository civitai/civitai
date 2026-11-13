import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRevocationCheck, type RevocationCheckConfig } from '../revocation-check';
import { impersonatorCutKey, type SessionRegistryRedis } from '../session-registry';
import { SESSION_REGISTRY_KEYS } from '../session-registry-keys';
import type { SessionClaims } from '../types';

// The shared check keeps the revocation markers it has read, so a revocation this process has seen still
// denies when a later read fails. A session with no known marker still fails open (signing everyone out during
// an outage is not the policy), and that verdict is reported.

const K = SESSION_REGISTRY_KEYS;
const USER_CUT_7 = `${K.userCut}:7`;

/** An in-memory store whose every read can be switched to fail. */
function fakeStore() {
  const hashes = new Map<string, Map<string, string>>();
  const strings = new Map<string, string>();
  const state = { mode: 'up' as 'up' | 'rejects' | 'hangs' };
  const read = <T>(value: () => T): Promise<T> => {
    if (state.mode === 'hangs') return new Promise<T>(() => undefined);
    if (state.mode === 'rejects') return Promise.reject(new Error('ECONNREFUSED'));
    return Promise.resolve(value());
  };
  const redis = {
    hGet: vi.fn((key: string, field: string) => read(() => hashes.get(key)?.get(field) ?? null)),
    get: vi.fn((key: string) => read(() => strings.get(key) ?? null)),
  };
  return {
    redis: redis as unknown as SessionRegistryRedis,
    calls: redis,
    state,
    setHash(key: string, field: string, value: string) {
      const m = hashes.get(key) ?? new Map<string, string>();
      m.set(field, value);
      hashes.set(key, m);
    },
    deleteHash(key: string, field: string) {
      hashes.get(key)?.delete(field);
    },
    setString(key: string, value: string) {
      strings.set(key, value);
    },
    deleteString(key: string) {
      strings.delete(key);
    },
  };
}

const claims = (over: Partial<SessionClaims> = {}): SessionClaims =>
  ({ jti: 't7', sub: '7', signedAt: 1000, ...over } as SessionClaims);

const breakerOpen = () =>
  Promise.reject(Object.assign(new Error('sys read breaker open'), { reason: 'breaker-open' }));

// Each outage shape: the store rejects; the store never answers and the deadline ends the wait; and the
// caller's breaker refuses the read without waiting (the main app's withSysReadBreaker once tripped).
type Outage = {
  name: string;
  reason: 'error' | 'timeout' | 'breaker-open';
  start: (s: ReturnType<typeof fakeStore>, breaker: { open: boolean }) => void;
};
const outages: Outage[] = [
  { name: 'rejects', reason: 'error', start: (s) => (s.state.mode = 'rejects') },
  { name: 'never answers', reason: 'timeout', start: (s) => (s.state.mode = 'hangs') },
  {
    name: 'is refused by an open breaker',
    reason: 'breaker-open',
    start: (s, b) => {
      s.state.mode = 'hangs';
      b.open = true;
    },
  },
];

let store: ReturnType<typeof fakeStore>;
let breaker: { open: boolean };
let onError: ReturnType<typeof vi.fn<NonNullable<RevocationCheckConfig['onError']>>>;
let check: (claims: SessionClaims) => Promise<boolean>;

/** A check over `store`, with the deadline race unless `breaker.open`. `markerCache` as given (default on). */
function build(markerCache?: boolean) {
  return createRevocationCheck({
    redis: () => store.redis,
    markerCache,
    timeoutMs: 20,
    // The built-in deadline race, unless the breaker is open: then the read is refused without waiting.
    bound: (read, ms) =>
      breaker.open
        ? breakerOpen()
        : Promise.race([
            read,
            new Promise<boolean>((_, reject) =>
              setTimeout(
                () => reject(Object.assign(new Error('timed out'), { reason: 'timeout' })),
                ms
              )
            ),
          ]),
    onError,
  });
}

beforeEach(() => {
  store = fakeStore();
  breaker = { open: false };
  onError = vi.fn<NonNullable<RevocationCheckConfig['onError']>>();
  check = build();
});

describe.each(outages)('createRevocationCheck while the store $name', ({ reason, start }) => {
  it('still denies a signed-out token whose marker this process has read', async () => {
    store.setHash(K.tokenState, 't7', 'invalid');
    expect(await check(claims())).toBe(true);

    start(store, breaker);
    expect(await check(claims())).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), reason, claims(), 'deny_cached');
  });

  it("still denies a banned user's earlier token once this process has read the user's cut", async () => {
    // The ban writes the user's cut; any read for that user returns it, whichever token asked.
    store.setString(USER_CUT_7, '5000');
    expect(await check(claims({ jti: 'other', signedAt: 6000 }))).toBe(false);

    start(store, breaker);
    expect(await check(claims({ jti: 'pre-ban', signedAt: 1000 }))).toBe(true);
    // The same predicate decides: a token signed after the cut is not revoked by it.
    expect(await check(claims({ jti: 'post-ban', signedAt: 6000 }))).toBe(false);
    expect(onError.mock.calls.map((c) => c[3])).toEqual(['deny_cached', 'allow_unknown']);
  });

  it('still denies a token from a signed-out family whose marker this process has read', async () => {
    store.setHash(K.familyState, 'root', 'invalid');
    expect(await check(claims({ sid: 'root' }))).toBe(true);

    start(store, breaker);
    expect(await check(claims({ jti: 'sibling', sid: 'root' }))).toBe(true);
    expect(await check(claims({ jti: 'unrelated', sid: 'other' }))).toBe(false);
  });

  it('still applies a global cut-off this process has read', async () => {
    store.setString(K.all, new Date(5000).toISOString());
    expect(await check(claims({ signedAt: 6000 }))).toBe(false);

    start(store, breaker);
    expect(await check(claims({ jti: 'old', signedAt: 1000 }))).toBe(true);
    expect(await check(claims({ jti: 'new', signedAt: 6000 }))).toBe(false);
  });

  it('still applies an impersonation cut-off this process has read for the impersonating moderator', async () => {
    store.setString(impersonatorCutKey(K.userCut, 100), '5000');
    const impersonation = claims({ impersonatedBy: 100 } as Partial<SessionClaims>);
    expect(await check(impersonation)).toBe(true);

    start(store, breaker);
    expect(await check({ ...impersonation, jti: 'imp-2' })).toBe(true);
    // The moderator's own session is not an impersonation, so that cut does not touch it.
    expect(await check(claims({ jti: 'own', sub: '100' }))).toBe(false);
  });

  it('allows a session with no known marker, and reports that verdict', async () => {
    // POLICY PIN: no marker known means fail open, as before the record. Failing closed here would sign every
    // user out for the length of an outage.
    start(store, breaker);
    expect(await check(claims({ jti: 'never-seen', sub: '99' }))).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      reason,
      claims({ jti: 'never-seen', sub: '99' }),
      'allow_unknown'
    );
  });

  it('forgets a marker that a later answered read no longer returns', async () => {
    store.setString(USER_CUT_7, '5000');
    expect(await check(claims())).toBe(true);
    store.deleteString(USER_CUT_7);
    expect(await check(claims())).toBe(false);

    start(store, breaker);
    expect(await check(claims())).toBe(false);
    expect(onError).toHaveBeenLastCalledWith(expect.any(Error), reason, claims(), 'allow_unknown');
  });

  it('forgets a token marker that a later answered read returns as a refresh flag', async () => {
    store.setHash(K.tokenState, 't7', 'invalid');
    expect(await check(claims())).toBe(true);
    store.setHash(K.tokenState, 't7', 'refresh');
    expect(await check(claims())).toBe(false);

    start(store, breaker);
    expect(await check(claims())).toBe(false);
  });

  it('with markerCache: false, fails open exactly as before the record', async () => {
    check = build(false);
    store.setHash(K.tokenState, 't7', 'invalid');
    expect(await check(claims())).toBe(true); // the answered read is unchanged

    start(store, breaker);
    expect(await check(claims())).toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), reason, claims(), 'allow_unknown');
  });
});

describe('createRevocationCheck markerCache option', () => {
  it('is on when not given', async () => {
    check = build(undefined);
    store.setHash(K.tokenState, 't7', 'invalid');
    expect(await check(claims())).toBe(true);
    store.state.mode = 'rejects';
    expect(await check(claims())).toBe(true);
  });

  it('when false, wraps nothing: the store is read directly and nothing is recorded', async () => {
    check = build(false);
    store.setHash(K.tokenState, 't7', 'invalid');
    store.setString(USER_CUT_7, '5000');
    expect(await check(claims())).toBe(true);
    store.state.mode = 'rejects';
    expect(await check(claims())).toBe(false);
    expect(await check(claims({ jti: 'pre-ban' }))).toBe(false);
    expect(onError.mock.calls.map((c) => c[3])).toEqual(['allow_unknown', 'allow_unknown']);
  });
});

describe('createRevocationCheck with the store answering', () => {
  it('answers from the store, not from a marker it read earlier', async () => {
    store.setHash(K.tokenState, 't7', 'invalid');
    expect(await check(claims())).toBe(true);
    // The store no longer has it (the marker expired): the answered path follows the store.
    store.deleteHash(K.tokenState, 't7');
    expect(await check(claims())).toBe(false);
    expect(onError).not.toHaveBeenCalled();
  });

  it('makes the same store reads as without the record', async () => {
    const reads = async () => {
      store.calls.hGet.mockClear();
      store.calls.get.mockClear();
      await check(claims({ sid: 'root', impersonatedBy: 100 } as Partial<SessionClaims>));
      return [store.calls.hGet.mock.calls.length, store.calls.get.mock.calls.length];
    };
    const on = await reads();
    check = build(false);
    const off = await reads();
    // token state + family state; ALL + user cut + impersonator's user cut + impersonation cut.
    expect(on).toEqual([2, 4]);
    expect(off).toEqual(on);
  });
});
