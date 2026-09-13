import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import sourceSnapshot from './fixtures/flipt-store-scope.snapshot.json';
import {
  deriveSnapshotFromFlagShape,
  startFliptFixtureServer,
  SNAPSHOT_PATH,
  type FliptFixtureServer,
} from './fixtures/flipt-fixture-server';
import type { SessionUser } from '~/types/session';

/**
 * 🔴 THE MEASUREMENT BEHIND "GLOBAL-EVAL SEMANTICS" IN `app-blocks-flag.ts`.
 *
 * Several docblocks in that file used to reason:
 *
 *     no user → a global eval that can never match a segment → fail-closed / denied
 *
 * The premise is true. The conclusion does not follow from it — it follows from the
 * flag's BASE `enabled` value being `false`. When no rollout matches, Flipt answers
 * with the flag's own base value, so a base-`enabled: true` widening turns every
 * no-user branch in that file from a deny into a pass.
 *
 * ## This is a reproduction, not a discovery
 *
 * The inversion was already measured against PRODUCTION Flipt (v2.10.0, 2026-08-15)
 * and is recorded in `civitai/flipt-state`'s `scripts/validate-flag-shape.py`
 * docstring, with both controls firing. That validator exists to guard this exact
 * shape. What it CANNOT cover is the code side: it blocks the misconfiguration form
 * (a boolean flag whose rollouts are all segment-scoped must be base-false) but
 * deliberately exempts flags with no rollouts at all — which is precisely the shape
 * of an intended GA flip. So the config gate permits the GA by design, and the code
 * is the only control left on that half. This suite is that control's evidence.
 *
 * Nothing in THIS repo measured it, which is how the inference survived here: the
 * sibling suites stub `isFlipt` with a fake whose base is `false`, so they reproduce
 * the conclusion without ever exercising its precondition.
 *
 *   derived snapshot  →  a real HTTP server on localhost
 *                     →  the REAL `createFliptClient` from `@civitai/flipt`
 *                     →  the REAL `@flipt-io/flipt-client-js` wasm engine
 *                     →  the REAL `isAppBlocksAuthorEnabled` / `isAppBlocksEnabled`
 *
 * ## About the fixture
 *
 * DERIVED at runtime from `fixtures/flipt-store-scope.snapshot.json` — a real Flipt
 * v2 evaluation snapshot carrying the production flag SHAPE (base + a single
 * `SEGMENT_ROLLOUT_TYPE` whose `OR_SEGMENT_OPERATOR` combines an
 * `ALL_SEGMENT_MATCH_TYPE` moderator segment with an `ANY_SEGMENT_MATCH_TYPE`
 * allowlist). Only the key and `enabled` change. It is deliberately NOT a second
 * checked-in file: that source's own docblock notes a re-capture means re-anonymising
 * it, so a hand-edited twin would silently keep the old segment shape while still
 * claiming production fidelity. `base-false-control` is the same shape left at
 * `enabled: false`, so every `true` below is attributable to the base value and not
 * to the harness.
 *
 * ## What this suite structurally CANNOT see
 *
 * - The live production flag documents. Both flags are base `false` with segment
 *   rollouts TODAY, so this fixture is a hypothetical, deliberately: the point is
 *   that the code must not depend on that staying true.
 * - The real network path to production Flipt (TLS, auth, circuit breaker, refreshes).
 * - `FLIPT_LOCAL_OVERRIDES`, the other route to a no-user `true`. It is hard-disabled
 *   when `NODE_ENV === 'production'` (`packages/civitai-flipt/src/env.ts`).
 * - The 2 of 10 call sites that hand `isAppBlocksAuthorEnabled` a nullable subject.
 *   Those are a COMPILE error now, not a runtime one, so the guard for them is
 *   `pnpm typecheck` and there is deliberately no test here pretending otherwise.
 */

vi.hoisted(() => {
  process.env.SERVER_DOMAIN_GREEN = 'civitai.com';
  process.env.SERVER_DOMAIN_BLUE = 'civitai.blue';
  process.env.SERVER_DOMAIN_RED = 'civitai.red';
});

const URL_ENV = '__TEST_FLIPT_BASE_FLIP_URL';

vi.mock('~/server/flipt/client', async () => {
  const { buildRealFliptClientMock } = await import('./fixtures/flipt-fixture-server');
  return buildRealFliptClientMock('__TEST_FLIPT_BASE_FLIP_URL');
});

/**
 * The GA-flip hypothetical: `app-blocks-author` and `app-blocks-enabled` widened by
 * BASE while still carrying their segment rollout, plus the same shape left base-false
 * as the negative control.
 */
const baseTrueSnapshot = deriveSnapshotFromFlagShape(
  sourceSnapshot as never,
  'app-blocks-enabled',
  [
    { key: 'app-blocks-author', enabled: true },
    { key: 'app-blocks-enabled', enabled: true },
    { key: 'base-false-control', enabled: false },
  ]
);

let server: FliptFixtureServer;

beforeAll(async () => {
  server = await startFliptFixtureServer(baseTrueSnapshot);
  process.env[URL_ENV] = server.url;
});

afterAll(async () => {
  await server.close();
});

/** Minimal SessionUser — only the fields `buildFliptContext` reads. */
function sessionUser(id: number, extra: Partial<SessionUser> = {}): SessionUser {
  return { id, isModerator: false, tier: 'free', onboarding: 0, ...extra } as SessionUser;
}

const UNAFFILIATED_ID = 4242; // matches no segment in the derived snapshot

describe('a base-`enabled: true` flip, measured against the real Flipt engine', () => {
  it('INSTRUMENT CONTROL: the fixture server is reached, and an unknown key still fails closed', async () => {
    const { isFlipt } = await import('~/server/flipt/client');
    await expect(isFlipt('a-flag-that-does-not-exist')).resolves.toBe(false);
    expect(server.received.length).toBeGreaterThan(0);
    expect(server.received[0].url).toContain(SNAPSHOT_PATH);
    expect(server.received[0].environment).toBe('civitai-app');
    expect(server.received[0].auth).toBe('Bearer test-token');
  });

  it('FIXTURE CONTROL: the derived flags really carry a SEGMENT rollout (not a bare boolean, not a threshold)', async () => {
    // Without this, every `true` below could come from a flag with no rollouts at all,
    // or from a THRESHOLD rollout — both different shapes making a different claim, and
    // a 100% threshold would also make `base-false-control` true, so the negative
    // control would not catch the swap either. Assert the TYPE, which is what the
    // title claims; a length check does not.
    for (const flag of baseTrueSnapshot.flags) {
      const rollouts = (flag as { rollouts?: { type?: string }[] }).rollouts;
      expect(Array.isArray(rollouts)).toBe(true);
      expect(rollouts?.map((r) => r.type)).toContain('SEGMENT_ROLLOUT_TYPE');
    }
  });

  it('FIXTURE-GUARD CONTROL: the derivation helper REFUSES a template without a segment rollout', async () => {
    // Makes the guard reachable rather than merely present — the three refusal arms
    // are otherwise exercised by nothing, which is the shape this whole PR is about.
    const { deriveSnapshotFromFlagShape: derive } = await import('./fixtures/flipt-fixture-server');
    const ask = [{ key: 'x', enabled: true }];
    const shapes: Array<[string, unknown]> = [
      ['no rollouts key', { key: 't', enabled: false }],
      ['empty rollouts', { key: 't', enabled: false, rollouts: [] }],
      [
        'threshold rollout only',
        { key: 't', enabled: false, rollouts: [{ type: 'THRESHOLD_ROLLOUT_TYPE' }] },
      ],
    ];
    for (const [label, flag] of shapes) {
      expect(() =>
        derive({ namespace: { key: 'default' }, flags: [flag] } as never, 't', ask)
      ).toThrow(/carries no SEGMENT_ROLLOUT_TYPE rollout/);
      expect(label).toBeTruthy();
    }
    // POSITIVE CONTROL — the real template is accepted, so the three refusals above
    // are attributable to the shape and not to the helper rejecting everything.
    expect(() => derive(sourceSnapshot as never, 'app-blocks-enabled', ask)).not.toThrow();
  });

  it('🔴 THE RETRACTED PREMISE, MEASURED: a GLOBAL eval of a base-true segmented flag returns TRUE', async () => {
    const { isFlipt } = await import('~/server/flipt/client');
    // No entityId, no context — the exact call every no-user branch in
    // app-blocks-flag.ts makes. The segment genuinely cannot match; the answer is
    // the flag's BASE value, and here that is `true`.
    await expect(isFlipt('app-blocks-author')).resolves.toBe(true);
    await expect(isFlipt('app-blocks-enabled')).resolves.toBe(true);
    // NEGATIVE CONTROL, same shape and the same rollout, base `false` → `false`.
    // So the two `true`s above are attributable to the base value, not the harness.
    await expect(isFlipt('base-false-control')).resolves.toBe(false);
  });

  it('the segment still cannot match a global eval — the premise was right, only the conclusion was not', async () => {
    const { isFlipt } = await import('~/server/flipt/client');
    const { buildFliptContext } = await import('~/server/services/feature-flags.service');
    // `base-false-control` carries the moderator segment. WITH a moderator context it
    // matches and resolves true; with the global (no-context) eval above it did not.
    const mod = sessionUser(777, { isModerator: true });
    await expect(
      isFlipt('base-false-control', String(mod.id), buildFliptContext(mod))
    ).resolves.toBe(true);
  });

  it('the author gate evaluates a real subject against the base-true flag (the path that still exists)', async () => {
    const { isAppBlocksAuthorEnabled } = await import('~/server/services/app-blocks-flag');
    // `isAppBlocksAuthorEnabled` has no no-user branch left to test at runtime — its
    // `user` parameter is required and non-nullable, so the undefined case is a
    // COMPILE error. What remains testable is that a present subject is still
    // evaluated normally under the same flag, i.e. the type change did not turn the
    // helper into a blanket deny.
    await expect(isAppBlocksAuthorEnabled({ user: sessionUser(UNAFFILIATED_ID) })).resolves.toBe(
      true
    );
  });

  it('isAppBlocksEnabled KEEPS its no-user global eval — deliberately, because it is a kill-switch', async () => {
    const { isAppBlocksEnabled } = await import('~/server/services/app-blocks-flag');
    // The asymmetry with the author helper, pinned so nobody "unifies" them. A
    // kill-switch answers "is the feature on at all", which a subject-less machine
    // path may legitimately ask and which the base value IS. A capability answers
    // "may THIS subject", which is unanswerable without one.
    await expect(isAppBlocksEnabled()).resolves.toBe(true);
  });
});
