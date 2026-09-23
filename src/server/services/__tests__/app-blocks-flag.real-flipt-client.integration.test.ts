import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import snapshot from './fixtures/flipt-store-scope.snapshot.json';
import {
  startFliptFixtureServer,
  SNAPSHOT_PATH,
  type FliptFixtureServer,
} from './fixtures/flipt-fixture-server';
import type { SessionUser } from '~/types/session';

/**
 * 🔴 THE ONE LAYER THE OTHER STORE-SCOPE SUITES CANNOT SEE: the REAL Flipt client.
 *
 * `app-listings.router.read-flag-gate.test.ts` MOCKS `resolveStoreVisibilityScope`
 * outright (it proves the middleware→procedure ctx plumbing, nothing about the
 * answer). `app-blocks-flag.external-scope.seam.test.ts` runs both REAL sides but
 * against a hand-written fake of the Flipt CONFIG — a truth table, not the client.
 * So between them, every layer of the store gate is pinned EXCEPT the one that
 * actually decides: `createFliptClient` → the wasm evaluation engine → the segment
 * matcher. civitai#3983 was diagnosed with 75 of those tests green.
 *
 * This suite closes that gap end to end, with nothing about the evaluator faked:
 *
 *   fixture snapshot  →  a real HTTP server on localhost
 *                     →  the REAL `createFliptClient` from `@civitai/flipt`
 *                     →  the REAL `@flipt-io/flipt-client-js` wasm engine
 *                     →  the REAL `resolveStoreVisibilityScope` / `buildFliptContext`
 *
 * ## About the fixture
 *
 * `fixtures/flipt-store-scope.snapshot.json` is a real Flipt v2 evaluation snapshot
 * (`GET /internal/v1/evaluation/snapshot/namespace/default`), captured from a Flipt
 * server loaded with the production flag DEFINITIONS for the three store flags, then
 * trimmed to those flags. It therefore carries the production SHAPE verbatim —
 * `enabled: false` base + a single `SEGMENT_ROLLOUT_TYPE` whose `OR_SEGMENT_OPERATOR`
 * combines an `ALL_SEGMENT_MATCH_TYPE` moderator segment (`isModerator eq "true"`)
 * with an `ANY_SEGMENT_MATCH_TYPE` allowlist segment (`userId isoneof [...]`).
 *
 * 🔴 The user ids in it are SYNTHETIC (`9000xxxxx`). This repo is public; the real
 * cohort allowlists are not ours to publish, and the ids are not what is under test —
 * the constraint/rollout SHAPE is. Re-capturing the fixture means re-anonymising it.
 *
 * ## What this suite structurally CANNOT see
 *
 * - The live production flag document. The fixture is a point-in-time copy of the
 *   shape; a live config edit that changes the shape will not fail this suite.
 * - The real network path to the production Flipt (TLS, auth token, the circuit
 *   breaker, `updateInterval` refreshes, a snapshot fetch that times out).
 * - The tRPC ctx plumbing downstream of the resolver (that is the router suite's job)
 *   and the REST handler's own branch on the returned scope.
 * - Whichever build artifact production is actually running.
 */

// Read at IMPORT time by feature-flags.service (color-host sets), mirroring the
// sibling seam suite.
vi.hoisted(() => {
  process.env.SERVER_DOMAIN_GREEN = 'civitai.com';
  process.env.SERVER_DOMAIN_BLUE = 'civitai.blue';
  process.env.SERVER_DOMAIN_RED = 'civitai.red';
});

/**
 * The server + client-mock plumbing is shared with
 * `app-blocks-flag.base-enabled-flip.test.ts` via `fixtures/flipt-fixture-server`.
 * Only the SNAPSHOT differs between the two suites — this one serves the captured
 * production shapes (base OFF), that one serves the same shapes re-keyed base ON.
 */
let server: FliptFixtureServer;

vi.mock('~/server/flipt/client', async () => {
  const { buildRealFliptClientMock } = await import('./fixtures/flipt-fixture-server');
  return buildRealFliptClientMock('__TEST_FLIPT_URL');
});

beforeAll(async () => {
  server = await startFliptFixtureServer(snapshot);
  process.env.__TEST_FLIPT_URL = server.url;
});

afterAll(async () => {
  await server.close();
});

/** Minimal SessionUser — only the fields `buildFliptContext` reads. */
function sessionUser(id: number, extra: Partial<SessionUser> = {}): SessionUser {
  return { id, isModerator: false, tier: 'free', onboarding: 0, ...extra } as SessionUser;
}

/** Synthetic ids, matching the fixture's synthetic allowlists. */
const TESTERS_COHORT_ID = 900001001; // in `testers` only → external-only store
const APP_DEV_TESTER_ID = 900000001; // in `app-dev-testers` → full store
const UNAFFILIATED_ID = 4242; // in no segment → dark
const MODERATOR_ID = 777;

describe('resolveStoreVisibilityScope over the REAL Flipt client (civitai#3983)', () => {
  it('INSTRUMENT CONTROL: the fixture server is actually reached, in the right environment', async () => {
    const { isFlipt } = await import('~/server/flipt/client');
    // A flag key that is NOT in the fixture: proves an unknown flag fails CLOSED
    // rather than the client answering `true` for everything.
    await expect(isFlipt('a-flag-that-does-not-exist')).resolves.toBe(false);
    expect(server.received.length).toBeGreaterThan(0);
    expect(server.received[0].url).toContain(SNAPSHOT_PATH);
    expect(server.received[0].environment).toBe('civitai-app');
    expect(server.received[0].auth).toBe('Bearer test-token');
  });

  it('POSITIVE CONTROL: the wasm engine really does match a segment (not a suite wired to nothing)', async () => {
    const { isFlipt } = await import('~/server/flipt/client');
    const { buildFliptContext } = await import('~/server/services/feature-flags.service');
    const user = sessionUser(TESTERS_COHORT_ID);
    await expect(
      isFlipt('app-listings-public-external', String(user.id), buildFliptContext(user))
    ).resolves.toBe(true);
    // ...and the same flag is false for someone outside the segment, so the `true`
    // above is attributable to the segment and not to a flag open to everyone.
    const other = sessionUser(UNAFFILIATED_ID);
    await expect(
      isFlipt('app-listings-public-external', String(other.id), buildFliptContext(other))
    ).resolves.toBe(false);
  });

  it('anonymous (no user) resolves `none` — the global eval matches no segment', async () => {
    const { resolveStoreVisibilityScope } = await import('~/server/services/app-blocks-flag');
    await expect(resolveStoreVisibilityScope()).resolves.toBe('none');
    await expect(resolveStoreVisibilityScope({ user: undefined })).resolves.toBe('none');
  });

  it('a logged-in user in NO cohort resolves `none`', async () => {
    const { resolveStoreVisibilityScope } = await import('~/server/services/app-blocks-flag');
    await expect(resolveStoreVisibilityScope({ user: sessionUser(UNAFFILIATED_ID) })).resolves.toBe(
      'none'
    );
  });

  it('🔴 the EXTERNAL-ONLY cohort resolves `public-external`, not `none` (the civitai#3983 symptom)', async () => {
    const { resolveStoreVisibilityScope } = await import('~/server/services/app-blocks-flag');
    await expect(
      resolveStoreVisibilityScope({ user: sessionUser(TESTERS_COHORT_ID) })
    ).resolves.toBe('public-external');
  });

  it('the app-dev-tester cohort resolves `full`', async () => {
    const { resolveStoreVisibilityScope } = await import('~/server/services/app-blocks-flag');
    await expect(
      resolveStoreVisibilityScope({ user: sessionUser(APP_DEV_TESTER_ID) })
    ).resolves.toBe('full');
  });

  it('a moderator resolves `full` and is NEVER narrowed to `public-external`', async () => {
    const { resolveStoreVisibilityScope } = await import('~/server/services/app-blocks-flag');
    // A moderator matches the `testers` segment too (its `isModerator eq "true"`
    // constraint), so this is exactly the case the priority order exists to protect.
    await expect(
      resolveStoreVisibilityScope({ user: sessionUser(MODERATOR_ID, { isModerator: true }) })
    ).resolves.toBe('full');
  });
});
