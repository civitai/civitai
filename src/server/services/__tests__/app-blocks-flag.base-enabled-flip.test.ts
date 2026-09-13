import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import baseTrueSnapshot from './fixtures/flipt-base-enabled-flip.snapshot.json';
import type { SessionUser } from '~/types/session';

/**
 * 🔴 THE MEASUREMENT BEHIND "GLOBAL-EVAL SEMANTICS" IN `app-blocks-flag.ts`, AND THE
 * REGRESSION GUARD FOR THE INFERENCE THAT WAS RETRACTED WITH IT.
 *
 * Several docblocks in `app-blocks-flag.ts` used to reason:
 *
 *     no user → a global eval that can never match a segment → fail-closed / denied
 *
 * The premise is true. The conclusion does not follow from it — it follows from the
 * flag's BASE `enabled` value being `false`. When no rollout matches, Flipt answers
 * with the flag's own base value, so a base-`enabled: true` widening turns every
 * no-user branch in that file from a deny into a pass.
 *
 * Nothing in the repo measured that, which is exactly how the inference survived: the
 * sibling suites stub `isFlipt` with a fake whose base is `false`, so they reproduce
 * the conclusion without ever exercising its precondition. This suite runs the REAL
 * client against a REAL evaluation snapshot whose flags are base `enabled: true`:
 *
 *   fixture snapshot  →  a real HTTP server on localhost
 *                     →  the REAL `createFliptClient` from `@civitai/flipt`
 *                     →  the REAL `@flipt-io/flipt-client-js` wasm engine
 *                     →  the REAL `isAppBlocksAuthorEnabled` / `isAppBlocksEnabled`
 *
 * ## About the fixture
 *
 * `fixtures/flipt-base-enabled-flip.snapshot.json` is the sibling
 * `flipt-store-scope.snapshot.json` (a real Flipt v2 evaluation snapshot carrying the
 * production flag SHAPE — base + a single `SEGMENT_ROLLOUT_TYPE` whose
 * `OR_SEGMENT_OPERATOR` combines an `ALL_SEGMENT_MATCH_TYPE` moderator segment with an
 * `ANY_SEGMENT_MATCH_TYPE` allowlist) re-keyed to `app-blocks-author` /
 * `app-blocks-enabled` with `enabled` flipped to `true`. It models ONE thing: the
 * forcing condition this guard exists for — a base-true flip of a flag that still
 * carries its segment rollout. `base-false-control` is the same shape left at
 * `enabled: false`, so every `true` below is attributable to the base value and not to
 * the harness. The user ids are SYNTHETIC (`9000xxxxx`); this repo is public.
 *
 * ## What this suite structurally CANNOT see
 *
 * - The live production flag documents. Both flags are base `false` with segment
 *   rollouts TODAY (`civitai/flipt-state`, `civitai-app/default/features.yaml`), so
 *   this fixture is a hypothetical, deliberately: the point is that the code must not
 *   depend on that staying true.
 * - The real network path to production Flipt (TLS, auth, circuit breaker, refreshes).
 * - `FLIPT_LOCAL_OVERRIDES`, the other route to a no-user `true`. It is hard-disabled
 *   when `NODE_ENV === 'production'` (`packages/civitai-flipt/src/env.ts`).
 * - Any call site. The router-level consequence is pinned separately, by
 *   `blocks.router.flag-gate-hydrate.test.ts`.
 */

vi.hoisted(() => {
  process.env.SERVER_DOMAIN_GREEN = 'civitai.com';
  process.env.SERVER_DOMAIN_BLUE = 'civitai.blue';
  process.env.SERVER_DOMAIN_RED = 'civitai.red';
});

const SNAPSHOT_PATH = '/internal/v1/evaluation/snapshot/namespace/default';

/** Requests the fake Flipt actually received — used as the instrument control. */
const received: { url: string; environment?: string; auth?: string }[] = [];

let server: Server;

/**
 * Substitutes ONLY the app's env plumbing (`~/env/server` is not loadable in a unit
 * run): the exported `isFlipt` is a REAL `createFliptClient` instance pointed at the
 * fixture server. The evaluator, its cache, and the segment matcher are production code.
 */
vi.mock('~/server/flipt/client', async () => {
  const { createFliptClient } = await import('@civitai/flipt');
  const flipt = createFliptClient({
    url: process.env.__TEST_FLIPT_BASE_FLIP_URL as string,
    clientToken: 'test-token',
    environment: 'civitai-app',
    log: () => undefined,
    onInitError: (e) => {
      throw e;
    },
  });
  return {
    isFlipt: flipt.isEnabled,
    isFliptSync: flipt.isEnabledSync,
    getFliptVariant: flipt.getVariant,
    getFliptBoolean: flipt.getBoolean,
    ensureFliptInitialized: flipt.ensureInitialized,
  };
});

beforeAll(async () => {
  server = createServer((req, res) => {
    received.push({
      url: req.url ?? '',
      environment: req.headers['x-flipt-environment'] as string | undefined,
      auth: req.headers.authorization as string | undefined,
    });
    if (!req.url?.startsWith(SNAPSHOT_PATH)) {
      res.writeHead(404).end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(baseTrueSnapshot));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  process.env.__TEST_FLIPT_BASE_FLIP_URL = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Minimal SessionUser — only the fields `buildFliptContext` reads. */
function sessionUser(id: number, extra: Partial<SessionUser> = {}): SessionUser {
  return { id, isModerator: false, tier: 'free', onboarding: 0, ...extra } as SessionUser;
}

const UNAFFILIATED_ID = 4242; // matches no segment in the fixture

describe('a base-`enabled: true` flip, measured against the real Flipt engine', () => {
  it('INSTRUMENT CONTROL: the fixture server is reached, and an unknown key still fails closed', async () => {
    const { isFlipt } = await import('~/server/flipt/client');
    await expect(isFlipt('a-flag-that-does-not-exist')).resolves.toBe(false);
    expect(received.length).toBeGreaterThan(0);
    expect(received[0].url).toContain(SNAPSHOT_PATH);
    expect(received[0].environment).toBe('civitai-app');
    expect(received[0].auth).toBe('Bearer test-token');
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

  it('🔴 isAppBlocksAuthorEnabled DENIES an undefined user even when the flag is base-true', async () => {
    const { isAppBlocksAuthorEnabled } = await import('~/server/services/app-blocks-flag');
    // The claim the docblock makes. Before the fix this resolved TRUE here, because the
    // no-user branch was `return isFlipt(APP_BLOCKS_AUTHOR_FLAG)` and the base is true.
    await expect(isAppBlocksAuthorEnabled({ user: undefined })).resolves.toBe(false);
    await expect(isAppBlocksAuthorEnabled()).resolves.toBe(false);
  });

  it('the author gate still PASSES a real subject under the same base-true flag (not a suite wired to deny)', async () => {
    const { isAppBlocksAuthorEnabled } = await import('~/server/services/app-blocks-flag');
    // POSITIVE CONTROL: same flag, same fixture, same call — only a user is added. If
    // this were also `false` the assertion above would prove nothing about the branch.
    await expect(isAppBlocksAuthorEnabled({ user: sessionUser(UNAFFILIATED_ID) })).resolves.toBe(
      true
    );
  });

  it('isAppBlocksEnabled KEEPS its no-user global eval — deliberately, for the machine caller', async () => {
    const { isAppBlocksEnabled } = await import('~/server/services/app-blocks-flag');
    // Documented and intentional: the no-arg overload reads the flag's base value for
    // `pages/api/v1/developer/block-manifests.ts`, the only no-arg call site. This
    // asserts the ASYMMETRY with the author helper above is real, so nobody "fixes"
    // one of them into the other by accident.
    await expect(isAppBlocksEnabled()).resolves.toBe(true);
  });
});
