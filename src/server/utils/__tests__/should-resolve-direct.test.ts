import type { NextApiRequest } from 'next';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';
import { shouldResolveDirect } from '../request-helpers';

// The canonical `~/env/server` mock, not a per-file `vi.mock` factory. A wholesale
// one-key replacement blanks every OTHER env read in the module graph under test,
// and `~/env/server` is on the repo's pending-migration list — a new file should
// not add to it. Per-file overrides are the supported spelling for a value the
// code reads at CALL time, which this one is.
const setAllowlist = (entries: string[]) =>
  setEnv({ STORAGE_RESOLVER_DIRECT_USER_AGENTS: entries });

const reqWithUA = (userAgent?: string) =>
  ({ headers: userAgent === undefined ? {} : { 'user-agent': userAgent } } as NextApiRequest);

describe('shouldResolveDirect', () => {
  beforeEach(() => {
    resetEnv();
    setAllowlist([]);
  });

  // The default must be off. This is the test that makes the feature safe to
  // merge ahead of the config that turns it on: an empty allowlist has to mean
  // "nobody", including for the exact agent we intend to allow later.
  it('is off by default, for every caller', () => {
    for (const ua of ['some-internal-client/1.2.3', 'Mozilla/5.0', 'curl/8.0', undefined]) {
      expect(shouldResolveDirect(reqWithUA(ua))).toBe(false);
    }
  });

  it('matches an allowlisted agent as a substring', () => {
    setAllowlist(['some-internal-client']);
    expect(shouldResolveDirect(reqWithUA('some-internal-client/1.2.3'))).toBe(true);
  });

  it('does not match an agent that is absent from the allowlist', () => {
    setAllowlist(['some-internal-client']);
    // Every one of these would be served directly by a `true`-by-default bug, and
    // the middle two are the near-misses a sloppy substring test would let through.
    expect(shouldResolveDirect(reqWithUA('Mozilla/5.0'))).toBe(false);
    expect(shouldResolveDirect(reqWithUA('some-internal'))).toBe(false);
    expect(shouldResolveDirect(reqWithUA('client/1.2.3'))).toBe(false);
  });

  it('matches case-insensitively in both directions', () => {
    setAllowlist(['Some-Internal-Client']);
    expect(shouldResolveDirect(reqWithUA('SOME-INTERNAL-CLIENT/1.0'))).toBe(true);
  });

  it('tolerates whitespace around a configured entry', () => {
    setAllowlist([' some-internal-client ']);
    expect(shouldResolveDirect(reqWithUA('some-internal-client/1.2.3'))).toBe(true);
  });

  // 🔴 A trailing comma in config produces an empty entry, and `''.includes()` is
  // true for EVERY string — so the naive implementation turns one stray character
  // into a fleet-wide direct rollout, silently and at real cost. This is the
  // reason the empty-needle check exists.
  it('never lets an empty allowlist entry match everything', () => {
    setAllowlist(['some-internal-client', '']);
    expect(shouldResolveDirect(reqWithUA('Mozilla/5.0'))).toBe(false);
    expect(shouldResolveDirect(reqWithUA('curl/8.0'))).toBe(false);
    // ...while the legitimate entry alongside it still works.
    expect(shouldResolveDirect(reqWithUA('some-internal-client/1.2.3'))).toBe(true);
  });

  it('returns false when the caller sends no user agent', () => {
    setAllowlist(['some-internal-client']);
    expect(shouldResolveDirect(reqWithUA(undefined))).toBe(false);
  });

  // 🔴 The empty-string case is only the most extreme member of a family. A one-
  // or two-character entry — a truncated paste — matches essentially every real
  // user agent, producing the same fleet-wide rollout as an empty one. Guarding
  // only length 0 closes the tidiest member and leaves the rest open.
  it.each(['', 'c', 'in'])(
    'ignores an allowlist entry too short to be a real token: %o',
    (entry) => {
      setAllowlist([entry]);
      expect(shouldResolveDirect(reqWithUA('Mozilla/5.0 (Macintosh; Intel Mac OS X)'))).toBe(false);
      expect(shouldResolveDirect(reqWithUA('curl/8.0'))).toBe(false);
    }
  );

  it('still honours a short-but-plausible entry at the floor', () => {
    // Three characters is the floor, not a rejection: an entry this short is
    // admitted, so the guard cannot be read as "we quietly dropped your config".
    setAllowlist(['abc']);
    expect(shouldResolveDirect(reqWithUA('abc-client/1.0'))).toBe(true);
    expect(shouldResolveDirect(reqWithUA('Mozilla/5.0'))).toBe(false);
  });

  it('a too-short entry does not disable the valid entries beside it', () => {
    setAllowlist(['c', 'some-internal-client']);
    expect(shouldResolveDirect(reqWithUA('some-internal-client/1.2.3'))).toBe(true);
    expect(shouldResolveDirect(reqWithUA('Mozilla/5.0'))).toBe(false);
  });
});
