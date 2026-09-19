import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * The crucible flag is the only thing standing between a Buzz-moving feature and the public,
 * and it is read from twelve tRPC procedures, four pages and the nav registry — all through
 * `getFeatureFlags`. So this drives the real registry and real `hasFeature`, stubbing only the
 * Flipt EDGE.
 *
 * 🔴 The stub models Flipt's ACTUAL contract, not a convenient one. For a boolean flag, an
 * evaluation that matches no rollout returns the flag's own `enabled` BASE value — it is not a
 * deny. A stub that returns `false` for a non-matching user would disagree with production in
 * exactly the direction you were hoping for, which is how a base-`enabled: true` flag shipped
 * once before (flipt-state#62, and #4807 on this side). `CRUCIBLE_FLAG` below is a transcription
 * of the intended flag shape, base included.
 *
 * Not loaded here: the Flipt server and the flipt-state YAML, which lives in another repo and is
 * guarded there by `scripts/validate-flag-shape.py`.
 */

const { mockIsFliptSync } = vi.hoisted(() => ({ mockIsFliptSync: vi.fn() }));

vi.mock('~/server/flipt/client', () => ({
  isFliptSync: (...a: unknown[]) => mockIsFliptSync(...a),
  isFlipt: vi.fn(),
  getFliptVariant: vi.fn(),
  getFliptBoolean: vi.fn(),
  ensureFliptInitialized: vi.fn(async () => undefined),
  FLIPT_FEATURE_FLAGS: {},
}));

import { getFeatureFlags } from '~/server/services/feature-flags.service';
import type { SessionUser } from '~/types/session';

/** Transcription of the intended flipt-state shape. The base is the part that matters. */
const CRUCIBLE_FLAG = { key: 'crucible', enabled: false };

/** What real Flipt answers: the matching rollout's value, else the flag's own base. */
const fliptAnswer = (inCohort: boolean) => (inCohort ? true : CRUCIBLE_FLAG.enabled);

let nextId = 1;

const user = (over: Partial<SessionUser> = {}): SessionUser =>
  ({
    id: nextId++,
    showNsfw: false,
    blurNsfw: true,
    browsingLevel: 1,
    onboarding: 0,
    permissions: [],
    ...over,
  } as SessionUser);

const mod = () => user({ isModerator: true });
const granted = () => user({ permissions: ['crucible'] });

/**
 * `getFeatureFlags` memoizes on a key built from the user's identity and the host, for 10s.
 * These cases deliberately vary the Flipt answer for the same shape of caller, so every call
 * gets a fresh identity — a shared one would serve the previous case's cached verdict and the
 * suite would assert against a stale value while looking green.
 *
 * Read through a falsy check rather than `=== false`: the returned object is SPARSE, so a flag
 * that is off is ABSENT, and that is exactly how `isFlagProtected` (`if (!features[flag])`) and
 * the page resolvers (`if (!features?.crucible)`) read it.
 */
const crucibleFor = (who: SessionUser | undefined) =>
  !!getFeatureFlags({ user: who, host: `t${nextId++}.example` }).crucible;

/** Flipt unreachable — `isFliptSync` answers null and static availability decides. */
const fliptDown = () => mockIsFliptSync.mockReturnValue(null);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('crucible flag — Flipt unavailable', () => {
  beforeEach(fliptDown);

  it('falls back to moderators', () => {
    expect(crucibleFor(mod())).toBe(true);
  });

  it('falls back to individually-granted users', () => {
    expect(crucibleFor(granted())).toBe(true);
  });

  it('denies an ordinary signed-in user', () => {
    expect(crucibleFor(user())).toBe(false);
  });

  it('denies an anonymous request', () => {
    expect(crucibleFor(undefined)).toBe(false);
  });

  it('does not widen the audience during an outage', () => {
    // The fallback reproduces who had access before the flag was Flipt-backed. If this ever
    // includes 'public' or 'user', a Flipt outage turns the feature on for everyone.
    expect(crucibleFor(user())).toBe(false);
    expect(crucibleFor(undefined)).toBe(false);
  });
});

describe('crucible flag — Flipt answering', () => {
  it('opens the feature to a user Flipt puts in the cohort, with no role', () => {
    mockIsFliptSync.mockReturnValue(fliptAnswer(true));
    expect(crucibleFor(user())).toBe(true);
  });

  it('is a real kill switch — Flipt false denies even a moderator', () => {
    mockIsFliptSync.mockReturnValue(fliptAnswer(false));
    expect(crucibleFor(mod())).toBe(false);
    expect(crucibleFor(granted())).toBe(false);
  });

  it('is evaluated against the crucible key', () => {
    mockIsFliptSync.mockReturnValue(fliptAnswer(true));
    crucibleFor(user());
    expect(mockIsFliptSync).toHaveBeenCalledWith('crucible', expect.anything(), expect.anything());
  });

  it('denies a non-matching evaluation only because the BASE is false', () => {
    // This is the assertion the earlier incident lacked. Flipt hands back `enabled` when no
    // rollout matches, so a base-true flag would open the feature to every anonymous request
    // while every role check still read "off".
    expect(CRUCIBLE_FLAG.enabled).toBe(false);
    mockIsFliptSync.mockReturnValue(fliptAnswer(false));
    expect(crucibleFor(undefined)).toBe(false);
  });

  it('would open the feature to everyone if the base were flipped to true', () => {
    // Negative control: proves the assertion above is load-bearing rather than incidental.
    mockIsFliptSync.mockReturnValue(true);
    expect(crucibleFor(undefined)).toBe(true);
  });
});

describe('crucible surfaces are all gated', () => {
  const read = (rel: string) => readFileSync(path.join(__dirname, '../../../..', rel), 'utf8');

  it.each([
    'src/pages/crucibles/index.tsx',
    'src/pages/crucibles/create.tsx',
    'src/pages/crucibles/[id]/index.tsx',
    'src/pages/crucibles/[id]/judge.tsx',
  ])('%s refuses to render when the flag is off', (page) => {
    const source = read(page);
    expect(source).toContain('features?.crucible');
    expect(source).toContain('notFound: true');
  });

  it('gates both crons on the jobs kill switch', () => {
    // The user-facing flag cannot gate these: a background evaluation has no user, matches no
    // segment, and reads the base — which is `false` for a segmented flag, so the jobs would
    // never run. They use the separate base-`true` `crucible-jobs-enabled` switch.
    for (const job of ['finalize-crucibles', 'sync-crucible-scores']) {
      const source = read(`src/server/jobs/${job}.ts`);
      expect(source).toContain('FLIPT_FEATURE_FLAGS.CRUCIBLE_JOBS_ENABLED');
      expect(source).toMatch(/if \(!\(await isFlipt\(/);
    }
  });

  it('keeps the two switches distinct', () => {
    // One flag for both would be unkillable in one direction or unrunnable in the other: the
    // crons must keep paying out crucibles already in flight when the feature is merely hidden.
    const enumSource = read('src/server/flipt/client.ts');
    expect(enumSource).toContain("CRUCIBLE_JOBS_ENABLED = 'crucible-jobs-enabled'");
    expect(enumSource).not.toContain("= 'crucible',");
  });

  it('gates every procedure on the crucible router', () => {
    const source = read('src/server/routers/crucible.router.ts');
    const procedures =
      source.match(/^\s{2}\w+: (public|guarded|protected|moderator)Procedure/gm) ?? [];
    const guards = source.match(/isFlagProtected\('crucible'\)/g) ?? [];

    // An ungated procedure is a hole in the gate that no page check can cover, so the counts
    // have to match rather than merely both being non-zero.
    expect(procedures.length).toBeGreaterThan(0);
    expect(guards).toHaveLength(procedures.length);
  });
});
