import type { NextApiRequest } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The allowlist is read per-call (not captured at module load), so a single mock
// object whose value we mutate between tests is enough to drive every case.
// vi.hoisted is required: vi.mock's factory is hoisted above the file's own
// top-level declarations, so a plain const would not exist yet when it runs.
const mockEnv = vi.hoisted(() => ({ STORAGE_RESOLVER_DIRECT_USER_AGENTS: [] as string[] }));
vi.mock('~/env/server', () => ({ env: mockEnv }));

import { shouldResolveDirect } from '../request-helpers';

const reqWithUA = (userAgent?: string) =>
  ({ headers: userAgent === undefined ? {} : { 'user-agent': userAgent } } as NextApiRequest);

describe('shouldResolveDirect', () => {
  beforeEach(() => {
    mockEnv.STORAGE_RESOLVER_DIRECT_USER_AGENTS = [];
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
    mockEnv.STORAGE_RESOLVER_DIRECT_USER_AGENTS = ['some-internal-client'];
    expect(shouldResolveDirect(reqWithUA('some-internal-client/1.2.3'))).toBe(true);
  });

  it('does not match an agent that is absent from the allowlist', () => {
    mockEnv.STORAGE_RESOLVER_DIRECT_USER_AGENTS = ['some-internal-client'];
    // Every one of these would be served directly by a `true`-by-default bug, and
    // the middle two are the near-misses a sloppy substring test would let through.
    expect(shouldResolveDirect(reqWithUA('Mozilla/5.0'))).toBe(false);
    expect(shouldResolveDirect(reqWithUA('some-internal'))).toBe(false);
    expect(shouldResolveDirect(reqWithUA('client/1.2.3'))).toBe(false);
  });

  it('matches case-insensitively in both directions', () => {
    mockEnv.STORAGE_RESOLVER_DIRECT_USER_AGENTS = ['Some-Internal-Client'];
    expect(shouldResolveDirect(reqWithUA('SOME-INTERNAL-CLIENT/1.0'))).toBe(true);
  });

  it('tolerates whitespace around a configured entry', () => {
    mockEnv.STORAGE_RESOLVER_DIRECT_USER_AGENTS = [' some-internal-client '];
    expect(shouldResolveDirect(reqWithUA('some-internal-client/1.2.3'))).toBe(true);
  });

  // 🔴 A trailing comma in config produces an empty entry, and `''.includes()` is
  // true for EVERY string — so the naive implementation turns one stray character
  // into a fleet-wide direct rollout, silently and at real cost. This is the
  // reason the empty-needle check exists.
  it('never lets an empty allowlist entry match everything', () => {
    mockEnv.STORAGE_RESOLVER_DIRECT_USER_AGENTS = ['some-internal-client', ''];
    expect(shouldResolveDirect(reqWithUA('Mozilla/5.0'))).toBe(false);
    expect(shouldResolveDirect(reqWithUA('curl/8.0'))).toBe(false);
    // ...while the legitimate entry alongside it still works.
    expect(shouldResolveDirect(reqWithUA('some-internal-client/1.2.3'))).toBe(true);
  });

  it('returns false when the caller sends no user agent', () => {
    mockEnv.STORAGE_RESOLVER_DIRECT_USER_AGENTS = ['some-internal-client'];
    expect(shouldResolveDirect(reqWithUA(undefined))).toBe(false);
  });
});
