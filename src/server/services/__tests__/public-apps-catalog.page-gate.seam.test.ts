import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'http';
import type { NextApiRequest } from 'next';
import type { SessionUser } from '~/types/session';

/**
 * 🔴 THE SEAM THIS CHANGE CREATES: the public REST catalog is OPEN while `/apps`
 * stays DARK — for the same anonymous viewer, in the same flag configuration.
 *
 * That combination is the entire point of `~/server/services/blocks/public-apps-catalog`
 * and it is not reachable by ANY setting of the three store flags: `appListings`,
 * `appBlocks` and `appListingsPublicExternal` all feed `hasAppsStoreAccess`, which
 * gates the `/apps` PAGE as well as the read scope, so granting public catalog access
 * through one of them would launch the store to every visitor. The grant therefore
 * lives on its own axis — and an axis nobody tests is an axis that quietly grows a
 * second consumer.
 *
 * ⚠️ ISOLATION IS THE FAILURE MODE HERE, so this file deliberately loads BOTH REAL
 * SIDES against ONE fake Flipt configuration:
 *   - READ PATH   real `resolveStoreVisibilityScope` → real `resolvePublicAppsCatalogScope`
 *                 (what `/api/v1/apps*` hands the listing service);
 *   - PAGE GATE   real `getFeatureFlags` → real `hasAppsStoreAccess` → real
 *                 `resolveAppsPageAccess` (what `/apps` does with the same viewer).
 * A suite that mocked either side could be green while the pair is incoherent — which
 * is precisely how civitai#3983 stayed invisible through 75 green store-scope tests.
 *
 * The RELATIONSHIP asserted, and it is behavioural (a rendered access decision), not
 * a spelling:
 *
 *      anonymous, no store flags  ⟹  read scope `full`  AND  `/apps` notFound
 *      privileged                 ⟹  read scope untouched by the grant
 *
 * ## What this suite structurally CANNOT see
 *
 * - Whether the live endpoint actually serves anything. Flipt is FAKED here; the
 *   production resolver defect (civitai#3983: no scope value at all for an anonymous
 *   principal) does not reproduce from source under vitest, so nothing in this file
 *   is evidence about production. The absent-scope cases are covered separately.
 * - The `/apps` page BODY's own React render. `resolveAppsPageAccess` is the SSR
 *   decision; the body re-checks the same shared predicate, pinned by
 *   `components/Apps/__tests__/appsStoreAccessCallSites.test.ts`.
 */

// Read at IMPORT time by feature-flags.service (color-host sets) — set before the
// module evaluates, mirroring the sibling seam suite.
vi.hoisted(() => {
  process.env.SERVER_DOMAIN_GREEN = 'civitai.com';
  process.env.SERVER_DOMAIN_BLUE = 'civitai.blue';
  process.env.SERVER_DOMAIN_RED = 'civitai.red';
});

type FlagShape =
  | { kind: 'absent' }
  | { kind: 'base'; enabled: boolean }
  | { kind: 'segment'; base: boolean; match: (ctx: Record<string, string>) => boolean };

const { flagState } = vi.hoisted(() => ({
  flagState: { flags: {} as Record<string, unknown> },
}));

/** `evalFlag` returns `null` for "flag not found", exactly like Flipt. */
function evalFlag(
  flag: string,
  _entityId: string,
  context: Record<string, string>
): boolean | null {
  const shape = (flagState.flags[flag] as FlagShape | undefined) ?? { kind: 'absent' };
  switch (shape.kind) {
    case 'absent':
      return null;
    case 'base':
      return shape.enabled;
    case 'segment':
      return shape.match(context) ? true : shape.base;
  }
}

vi.mock('~/server/flipt/client', () => ({
  // ASYNC: swallows "not found" and returns FALSE (see @civitai/flipt isEnabled).
  isFlipt: async (flag: string, entityId = 'global', context: Record<string, string> = {}) =>
    evalFlag(flag, entityId, context) ?? false,
  // SYNC: returns NULL for "not found" so the caller falls through to the static
  // availability (see @civitai/flipt isEnabledSync).
  isFliptSync: (flag: string, entityId = 'global', context: Record<string, string> = {}) =>
    evalFlag(flag, entityId, context),
  ensureFliptInitialized: async () => undefined,
}));

import { resolveAppsPageAccess } from '~/components/Apps/resolveAppsPageAccess';
import { resolveStoreVisibilityScope } from '../app-blocks-flag';
import { getFeatureFlags, getFeatureFlagsAsync } from '../feature-flags.service';
import {
  PUBLIC_APPS_CATALOG_DISABLED_FLAG,
  resolvePublicAppsCatalogScope,
} from '../blocks/public-apps-catalog';
import { hasAppsStoreAccess } from '~/shared/utils/app-blocks-access';

const LISTINGS = 'app-listings';
const BLOCKS = 'app-blocks-enabled';
const EXTERNAL = 'app-listings-public-external';

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

/** `getFeatureFlags` memoizes on (user, host, region) for 10s — vary the host. */
let hostSeq = 0;
function makeReq(): NextApiRequest {
  return { headers: { host: `c${hostSeq++}.civitai.com` } } as unknown as NextApiRequest;
}

type Ctx = { user?: SessionUser; req: NextApiRequest | IncomingMessage };

beforeAll(async () => {
  // Prime the service's private `_fliptModule` (our mock) so the SYNC Flipt branch
  // inside `hasFeature` is live. Without this the branch is skipped and every flag
  // falls to its static availability — the suite would be green and measuring nothing.
  await getFeatureFlagsAsync({ req: makeReq() });
});

beforeEach(() => {
  flagState.flags = {};
});

/** BOTH halves of the seam, measured against ONE flag config. */
async function measure(user?: SessionUser) {
  const own = await resolveStoreVisibilityScope({ user });
  const restScope = await resolvePublicAppsCatalogScope(own, 'rest-list');
  const features = getFeatureFlags({ user, req: makeReq() } as Ctx);
  const page = resolveAppsPageAccess({ features });
  return { own, restScope, pageGranted: 'props' in page, predicate: hasAppsStoreAccess(features) };
}

// ---------------------------------------------------------------------------
// Instrument controls — a verdict from an unvalidated harness is worthless
// ---------------------------------------------------------------------------

describe('the harness (validate the instrument before reading its verdict)', () => {
  it('🔴 POSITIVE CONTROL: the Flipt branch is LIVE — a config change moves BOTH sides', async () => {
    // Without this, "the page is dark" is indistinguishable from a fake wired to
    // nothing, and every assertion below would be about the harness.
    const user = makeUser({ id: 555 });
    const dark = await measure(user);
    expect(dark.pageGranted).toBe(false);
    expect(dark.own).toBe('none');

    flagState.flags[LISTINGS] = { kind: 'base', enabled: true } satisfies FlagShape;
    const lit = await measure(user);
    expect(lit.pageGranted).toBe(true);
    expect(lit.own).toBe('full');
  });

  it('🔴 POSITIVE CONTROL: the kill switch is LIVE — it moves the REST scope', async () => {
    // Proves the `withheld` arm below is a real branch and not an inert flag key.
    expect((await measure(undefined)).restScope).toBe('full');
    flagState.flags[PUBLIC_APPS_CATALOG_DISABLED_FLAG] = {
      kind: 'base',
      enabled: true,
    } satisfies FlagShape;
    expect((await measure(undefined)).restScope).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// The relationship
// ---------------------------------------------------------------------------

describe('anonymous viewer, no store flags — the intended production posture', () => {
  it('🔴 the REST catalog is OPEN and `/apps` is DARK, simultaneously', async () => {
    const m = await measure(undefined);

    // Read path: served the whole public catalog, by deliberate grant.
    expect(m.own).toBe('none');
    expect(m.restScope).toBe('full');

    // Page gate: unchanged, and it must STAY unchanged — this is the "did we
    // accidentally launch the store" guard. Behavioural: the SSR resolver's own
    // decision, plus the shared predicate it is built from.
    expect(m.pageGranted).toBe(false);
    expect(m.predicate).toBe(false);
  });

  it('a LOGGED-IN but non-privileged viewer is in exactly the same position', async () => {
    const m = await measure(makeUser({ id: 4242 }));
    expect(m.restScope).toBe('full');
    expect(m.pageGranted).toBe(false);
  });

  it('withholding the public catalog does NOT change the page gate either (the axes are independent)', async () => {
    flagState.flags[PUBLIC_APPS_CATALOG_DISABLED_FLAG] = {
      kind: 'base',
      enabled: true,
    } satisfies FlagShape;
    const m = await measure(undefined);
    expect(m.restScope).toBe('none');
    expect(m.pageGranted).toBe(false);
  });

  // The inverse of the trap: the grant must not be reachable FROM the store flags,
  // and the store flags must keep meaning what they meant. Enabling one still opens
  // the page — that is their job — which is why the grant could not be one of them.
  it.each([LISTINGS, BLOCKS, EXTERNAL])(
    'enabling the store flag `%s` still opens the PAGE — which is why the grant is not one of them',
    async (flag) => {
      flagState.flags[flag] = { kind: 'base', enabled: true } satisfies FlagShape;
      const m = await measure(makeUser({ id: 77 }));
      expect(m.pageGranted).toBe(true);
    }
  );
});

describe('a privileged principal is NOT narrowed by the public grant', () => {
  it('a moderator/tester keeps `full` — and the kill switch cannot take it away', async () => {
    flagState.flags[LISTINGS] = { kind: 'base', enabled: true } satisfies FlagShape;
    flagState.flags[PUBLIC_APPS_CATALOG_DISABLED_FLAG] = {
      kind: 'base',
      enabled: true,
    } satisfies FlagShape;
    const m = await measure(makeUser({ id: 7, isModerator: true }));

    expect(m.own).toBe('full');
    expect(m.restScope).toBe('full');
    expect(m.pageGranted).toBe(true);
  });

  it('the external-only cohort keeps `public-external` — the grant never rewrites a resolved scope', async () => {
    flagState.flags[EXTERNAL] = { kind: 'base', enabled: true } satisfies FlagShape;
    flagState.flags[PUBLIC_APPS_CATALOG_DISABLED_FLAG] = {
      kind: 'base',
      enabled: true,
    } satisfies FlagShape;
    const m = await measure(makeUser({ id: 9 }));

    expect(m.own).toBe('public-external');
    expect(m.restScope).toBe('public-external');
    expect(m.pageGranted).toBe(true);
  });
});
