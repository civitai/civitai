import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import promClient from 'prom-client';

/**
 * 🔴 THE KILL SWITCH, PROVEN — civitai#4048 follow-up 2.
 *
 * `civitai_app_store_public_catalog_decisions_total` has only ever recorded
 * `outcome="granted"` in production. **`withheld` has never moved.** The switch that
 * takes a public REST endpoint dark has therefore never been exercised by anything
 * except a test that mocked it away, and "the flag is a DISABLE flag so an absent
 * flag means public access stays ON" has, until this file, been a claim in a
 * docstring rather than a measurement.
 *
 * ⚠️ WHY THIS IS NOT ANOTHER `vi.mock('~/server/flipt/client')` SUITE. Every existing
 * suite that touches the switch — `blocks/__tests__/public-apps-catalog.test.ts`,
 * `public-apps-catalog.page-gate.seam.test.ts`, `src/tests/api/v1/apps/*` — replaces
 * `isFlipt` with a `vi.fn()` or a hand-written truth table. Each is then a fact about
 * that double, and the ONE property an operator has to bet on lives BELOW it: what
 * the real `isFlipt` does with a flag that is not in the Flipt config at all. A
 * hand-written double answers `false` there because its author wrote `?? false`; the
 * real one answers `false` because the wasm engine THROWS "flag not found", the
 * factory catches it and fails closed — a completely different mechanism that a
 * double cannot attest to.
 *
 * So the fake here is pushed one layer down, at `@flipt-io/flipt-client-js`: the
 * evaluation ENGINE is faked over a declared flag CONFIG, and everything above it is
 * real —
 *
 *   real `~/server/flipt/client`            (the app's isFlipt, its cache-bypass set,
 *                                            its connection resolution, its
 *                                            fail-closed init handling)
 *   real `@civitai/flipt` createFliptClient (localOverrides, eval cache, the
 *                                            try/catch that turns an engine throw
 *                                            into `false`)
 *   real `resolveStoreVisibilityScope`      (the caller's own scope)
 *   real `resolvePublicAppsCatalogScope`    (the decision under test)
 *   real `prom-client` counters             (asserted by VALUE, not by call count)
 *
 * 🔴 LABEL, honestly: this file is GREEN AT `origin/main` (15/15). It is COVERAGE for
 * a branch nothing exercised, not a regression test — the kill switch worked, nobody
 * had ever proved it end-to-end, and its `withheld` counter had never moved anywhere
 * outside a mock. The civitai#4048 REGRESSION coverage (a `public-external` caller is
 * widened while the grant is active) is red at base and lives in
 * `blocks/__tests__/public-apps-catalog.test.ts` and `src/tests/api/v1/apps/*`. The
 * one #4048 property asserted here — the never-narrows invariant at the seam — is
 * green at base too, because the code it replaces got that property for free from a
 * short-circuit this change removes; it is here so the restructure cannot silently
 * lose it.
 *
 * ## What this file structurally CANNOT see
 *
 * - Whether the flag, once created in flipt-state, is shaped the way the module doc
 *   requires (plain base boolean, no segments). The engine fake models a base
 *   boolean and an entity/context-sensitive shape, but the real Flipt config is not
 *   under test here.
 * - Whether the live endpoints serve anything. Handler rendering (empty page / 404)
 *   is `src/tests/api/v1/apps/apps.test.ts`; this file asserts the SCOPE both
 *   handlers branch on, for both entrypoint labels, which is the value that decides
 *   it.
 */

// Read at module-evaluation time by @civitai/flipt's `loadFliptTuning` and by the
// connection fallback. Set in `vi.hoisted` so they are in place before
// `~/server/flipt/client` constructs its singleton.
//
// 🔴 `FLIPT_EVAL_CACHE_TTL_MS=0` is load-bearing, not tidiness. The real client
// memoizes an evaluation for 10s by default and this flag is NOT in the
// cache-bypass set, so with the default TTL the FIRST answer in this file would be
// replayed for every later case and the whole matrix would be one measurement
// wearing many hats — green, and about nothing.
vi.hoisted(() => {
  process.env.FLIPT_EVAL_CACHE_TTL_MS = '0';
  process.env.FLIPT_URL = 'http://flipt.test';
  process.env.FLIPT_FETCHER_SECRET = 'test-token';
  delete process.env.FLIPT_LOCAL_OVERRIDES;
});

/** How a flag behaves in the faked engine. `absent` = not in the config at all. */
type FlagShape =
  | { kind: 'absent' }
  | { kind: 'base'; enabled: boolean }
  | { kind: 'segment'; base: boolean; match: (ctx: Record<string, string>) => boolean };

const { flagState, engineCalls } = vi.hoisted(() => ({
  flagState: { flags: {} as Record<string, unknown> },
  engineCalls: { keys: [] as string[] },
}));

/**
 * The evaluation ENGINE, faked — and faked at the layer where its ERROR behaviour is
 * what matters.
 *
 * 🔴 An unknown flag THROWS. That is what the real wasm engine does ("failed to get
 * flag"), it is what `@civitai/flipt`'s own comment on `isEnabledSync` documents
 * ("Swallow eval errors (incl. 'flag not found')"), and it is the entire mechanism
 * behind the polarity claim on `PUBLIC_APPS_CATALOG_DISABLED_FLAG`. A fake that
 * returned `{ enabled: false }` for an unknown flag would make the polarity test
 * pass by construction and prove nothing.
 */
vi.mock('@flipt-io/flipt-client-js', () => {
  class FliptClient {
    static async init() {
      return new FliptClient();
    }
    async refresh() {
      return undefined;
    }
    evaluateBoolean({
      flagKey,
      context = {},
    }: {
      flagKey: string;
      entityId: string;
      context?: Record<string, string>;
    }) {
      engineCalls.keys.push(flagKey);
      const shape = (flagState.flags[flagKey] as FlagShape | undefined) ?? { kind: 'absent' };
      switch (shape.kind) {
        case 'absent':
          throw new Error(`invalid request: failed to get flag information ${flagKey}`);
        case 'base':
          return { enabled: shape.enabled };
        case 'segment':
          return { enabled: shape.match(context) ? true : shape.base };
      }
    }
    evaluateVariant() {
      return { match: false, variantKey: '' };
    }
  }
  return { FliptClient };
});

import { isFlipt } from '~/server/flipt/client';
import { resolveStoreVisibilityScope } from '../app-blocks-flag';
import {
  PUBLIC_APPS_CATALOG_DISABLED_FLAG,
  PUBLIC_APPS_CATALOG_SCOPE,
  resolvePublicAppsCatalogScope,
} from '../blocks/public-apps-catalog';
import type { StoreScopeEntrypoint } from '~/server/prom/store-scope.metrics';
import type { SessionUser } from '~/types/session';

const EXTERNAL = 'app-listings-public-external';
const LISTINGS = 'app-listings';
const DECISIONS = 'civitai_app_store_public_catalog_decisions_total';

function makeUser(over: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 100,
    username: 'u',
    isModerator: false,
    tier: 'free',
    permissions: [],
    onboarding: 0,
    ...over,
  } as SessionUser;
}

/**
 * Read one series off the REAL prom-client registry.
 *
 * 🔴 Returns `null` — not `0` — when the metric is not registered at all. A reassuring
 * zero is indistinguishable from a probe wired to nothing, and this file's headline
 * claim is that a counter which has never moved in production CAN move. The
 * instrument control below asserts the handle exists before any zero is believed.
 */
async function decisions(
  outcome: string,
  entrypoint: StoreScopeEntrypoint
): Promise<number | null> {
  const metric = promClient.register.getSingleMetric(DECISIONS) as
    | promClient.Counter<string>
    | undefined;
  if (!metric) return null;
  const snapshot = await metric.get();
  const hit = snapshot.values.find(
    (v) => v.labels.outcome === outcome && v.labels.entrypoint === entrypoint
  );
  return hit?.value ?? 0;
}

/** The caller's own scope, then the public decision — both surfaces of the seam. */
async function measure(user?: SessionUser, entrypoint: StoreScopeEntrypoint = 'rest-list') {
  const own = await resolveStoreVisibilityScope({ user });
  const served = await resolvePublicAppsCatalogScope(own, entrypoint);
  return { own, served };
}

/**
 * `~/server/flipt/client` passes no `onEvalError`, so @civitai/flipt's default logs
 * every "flag not found" throw to `console.error`. Absent flags are the NORMAL,
 * as-merged state this file measures, so that is ~40 lines of expected stderr per
 * run. Filtered — not silenced: anything that is not that exact line still reaches
 * the console, so a real error here is not swallowed by the noise reduction.
 */
const realConsoleError = console.error;
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (args[0] === '[flipt] evaluation error:') return;
    realConsoleError(...args);
  });
});
afterAll(() => {
  vi.mocked(console.error).mockRestore();
});

beforeEach(() => {
  flagState.flags = {};
  engineCalls.keys = [];
});

// ---------------------------------------------------------------------------
// Instrument controls — a verdict from an unvalidated harness is worthless
// ---------------------------------------------------------------------------

describe('the harness (validate the instrument before reading its verdict)', () => {
  it('🔴 the REAL evaluation path is live: the engine is actually reached', async () => {
    // Without this, every "the flag is off" result below is indistinguishable from a
    // client that failed to initialize and is answering `false` to everything.
    flagState.flags[PUBLIC_APPS_CATALOG_DISABLED_FLAG] = {
      kind: 'base',
      enabled: true,
    } satisfies FlagShape;
    await expect(isFlipt(PUBLIC_APPS_CATALOG_DISABLED_FLAG)).resolves.toBe(true);
    expect(engineCalls.keys).toContain(PUBLIC_APPS_CATALOG_DISABLED_FLAG);
  });

  it('🔴 the eval cache is DISABLED: a config change is observed immediately', async () => {
    // The 10s default TTL would replay the first answer for the rest of the file.
    flagState.flags[PUBLIC_APPS_CATALOG_DISABLED_FLAG] = {
      kind: 'base',
      enabled: false,
    } satisfies FlagShape;
    await expect(isFlipt(PUBLIC_APPS_CATALOG_DISABLED_FLAG)).resolves.toBe(false);
    flagState.flags[PUBLIC_APPS_CATALOG_DISABLED_FLAG] = {
      kind: 'base',
      enabled: true,
    } satisfies FlagShape;
    await expect(isFlipt(PUBLIC_APPS_CATALOG_DISABLED_FLAG)).resolves.toBe(true);
  });

  it('🔴 the decision COUNTER exists in the real registry (a zero below is a value, not a miss)', async () => {
    expect(await decisions('withheld', 'rest-list')).not.toBeNull();
    expect(await decisions('granted', 'rest-list')).not.toBeNull();
  });

  it('🔴 POSITIVE CONTROL: the counter MOVES — `granted` increments by exactly one call', async () => {
    // The half that a probe wired to nothing cannot fake. Assert the DELTA, because
    // the registry is process-global and other cases in this file have already
    // incremented it.
    const before = (await decisions('granted', 'rest-detail')) ?? -1;
    await resolvePublicAppsCatalogScope('none', 'rest-detail');
    expect(await decisions('granted', 'rest-detail')).toBe(before + 1);
  });

  it('🔴 NEGATIVE CONTROL: the `withheld` series does NOT move when the switch is off', async () => {
    const before = (await decisions('withheld', 'rest-detail')) ?? -1;
    await resolvePublicAppsCatalogScope('none', 'rest-detail');
    expect(await decisions('withheld', 'rest-detail')).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// The polarity claim, measured through the real client
// ---------------------------------------------------------------------------

describe('🔴 FLAG POLARITY: an ABSENT flag means public access stays ON', () => {
  it('the real `isFlipt` returns false for a flag that is not in the config', async () => {
    // The engine THROWS for an unknown flag; `@civitai/flipt` catches and fails
    // closed. This is the mechanism the module doc's polarity paragraph asserts, and
    // nothing pinned it before — every other suite replaced `isFlipt` outright.
    expect(flagState.flags[PUBLIC_APPS_CATALOG_DISABLED_FLAG]).toBeUndefined();
    await expect(isFlipt(PUBLIC_APPS_CATALOG_DISABLED_FLAG)).resolves.toBe(false);
    // …and the throw really happened, so this is the fail-closed path rather than a
    // flag that quietly evaluated to `false`.
    expect(engineCalls.keys).toContain(PUBLIC_APPS_CATALOG_DISABLED_FLAG);
  });

  it('so the as-merged configuration serves the public floor to an anonymous caller', async () => {
    const before = (await decisions('granted', 'rest-list')) ?? -1;
    const m = await measure(undefined);
    expect(m.own).toBe('none');
    expect(m.served).toBe(PUBLIC_APPS_CATALOG_SCOPE);
    expect(await decisions('granted', 'rest-list')).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------
// The switch itself — the branch production has never taken
// ---------------------------------------------------------------------------

describe('🔴 the kill switch ENABLED: `withheld` moves, and both REST surfaces go dark', () => {
  beforeEach(() => {
    flagState.flags[PUBLIC_APPS_CATALOG_DISABLED_FLAG] = {
      kind: 'base',
      enabled: true,
    } satisfies FlagShape;
  });

  it.each(['rest-list', 'rest-detail'] as StoreScopeEntrypoint[])(
    'an anonymous caller at `%s` is served `none` AND the withheld counter increments',
    async (entrypoint) => {
      const before = (await decisions('withheld', entrypoint)) ?? -1;
      const m = await measure(undefined, entrypoint);

      // `none` is exactly what `/api/v1/apps` renders as an empty page and
      // `/api/v1/apps/{slug}` renders as a 404 — both handlers branch on this value.
      expect(m.own).toBe('none');
      expect(m.served).toBe('none');
      // 🔴 The counter, by VALUE. Asserting only the return value would pass on a
      // decision that took the right branch and recorded the wrong outcome — which
      // is the exact thing an operator watching this series would then misread.
      expect(await decisions('withheld', entrypoint)).toBe(before + 1);
    }
  );

  it('the two entrypoints are counted SEPARATELY (the label is not inert)', async () => {
    const beforeList = (await decisions('withheld', 'rest-list')) ?? -1;
    const beforeDetail = (await decisions('withheld', 'rest-detail')) ?? -1;
    await resolvePublicAppsCatalogScope('none', 'rest-list');
    expect(await decisions('withheld', 'rest-list')).toBe(beforeList + 1);
    expect(await decisions('withheld', 'rest-detail')).toBe(beforeDetail);
  });

  it('`granted` does NOT move while the switch is on (the branches are exclusive)', async () => {
    const before = (await decisions('granted', 'rest-list')) ?? -1;
    await measure(undefined);
    expect(await decisions('granted', 'rest-list')).toBe(before);
  });

  /**
   * 🔴 THE NEVER-NARROWS INVARIANT, AT THE SEAM (civitai#4048).
   *
   * The withheld branch withdraws the public FLOOR; it must not revoke an
   * entitlement the caller resolved for themselves. Driven end-to-end here — the
   * cohort membership comes from the real `resolveStoreVisibilityScope` reading the
   * real flag through the real client, not from a scope string handed to the
   * decision.
   */
  it('a `public-external` caller KEEPS `public-external` through the enabled switch', async () => {
    flagState.flags[EXTERNAL] = {
      kind: 'segment',
      base: false,
      match: (ctx) => ctx.userId === '777',
    } satisfies FlagShape;

    const m = await measure(makeUser({ id: 777 }));
    expect(m.own).toBe('public-external');
    expect(m.served).toBe('public-external');
  });

  it('a `full` caller keeps `full`, and never even reads the switch', async () => {
    flagState.flags[LISTINGS] = { kind: 'base', enabled: true } satisfies FlagShape;
    const user = makeUser({ id: 888 });
    const own = await resolveStoreVisibilityScope({ user });
    expect(own).toBe('full');

    engineCalls.keys = [];
    await expect(resolvePublicAppsCatalogScope(own, 'rest-list')).resolves.toBe('full');
    expect(engineCalls.keys).not.toContain(PUBLIC_APPS_CATALOG_DISABLED_FLAG);
  });
});

// ---------------------------------------------------------------------------
// The discrimination, in one test, against one config
// ---------------------------------------------------------------------------

describe('🔴 OFF → ON → OFF, through the real client', () => {
  it('the same anonymous caller flips floor → none → floor as the flag moves', async () => {
    // Asserting one state proves nothing: a decision that is simply dark satisfies
    // the ON arm, and one that ignores the flag satisfies the OFF arm. Only the
    // transition discriminates.
    expect((await measure(undefined)).served).toBe(PUBLIC_APPS_CATALOG_SCOPE);

    flagState.flags[PUBLIC_APPS_CATALOG_DISABLED_FLAG] = {
      kind: 'base',
      enabled: true,
    } satisfies FlagShape;
    expect((await measure(undefined)).served).toBe('none');

    flagState.flags[PUBLIC_APPS_CATALOG_DISABLED_FLAG] = {
      kind: 'base',
      enabled: false,
    } satisfies FlagShape;
    expect((await measure(undefined)).served).toBe(PUBLIC_APPS_CATALOG_SCOPE);
  });

  it('an explicitly-DISABLED flag is the same as an absent one (a created-but-off switch is safe)', async () => {
    // Two different mechanisms reaching the same answer — `enabled: false` returns
    // false, an absent flag throws and is caught. An operator who creates the flag
    // before flipping it must not take the endpoint dark by doing so.
    flagState.flags[PUBLIC_APPS_CATALOG_DISABLED_FLAG] = {
      kind: 'base',
      enabled: false,
    } satisfies FlagShape;
    expect((await measure(undefined)).served).toBe(PUBLIC_APPS_CATALOG_SCOPE);
  });
});
