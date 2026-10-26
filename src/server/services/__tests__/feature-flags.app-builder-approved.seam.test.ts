import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE SEAM for the app-builder grant. An approved `AppAccessRequest` has to cross four surfaces
 * before a person sees the App Assistant, and each is testable — and meaningless — on its own:
 *
 *   EXISTS approved AppAccessRequest     (the hub producer's query; pinned against Postgres in
 *                                         apps/auth/.../session-producer.app-builder.pglite.test.ts)
 *     → apps/auth `shapeSessionUser`     → `SessionUser.appBuilderApproved`
 *     → `buildFliptContext`              → `appBuilderApproved: "true"`
 *     → the flag evaluators              → `appAssistant` / `appBlocks` / `appBlocksAuthor` …
 *     → `resolveAppsBuildPageMode`       → `/apps/build` renders the assistant
 *
 * This drives REAL code at every hop and stubs only the Flipt edge, whose stub evaluates a
 * transcription of the flipt-state flags AFTER the companion change: each builder flag's rollout is
 * the OR of `moderators`, `app-dev-testers`, `app-builder-approved` (and `testers` where the YAML
 * has it) over `enabled: false`, which is the no-match default real Flipt returns.
 *
 * Both evaluators are covered because they are different request paths: `getFeatureFlagsAsync`
 * (eager, the SSR seed) and `getFeatureFlagsLazy` (per-key, every tRPC context). The session they
 * are handed is the same object every path reads — civ-token, API key / OAuth bearer and block
 * token subjects all resolve it through `sessionClient` from the hub cache.
 *
 * Not loaded here, stated plainly: the Flipt server and the flipt-state YAML. The transcription
 * below can drift from the YAML; flipt-state's own validators guard the YAML side.
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

import {
  shapeSessionUser,
  type ProducerUserRow,
} from '../../../../apps/auth/src/lib/server/auth/session-shape';
import {
  buildFliptContext,
  getFeatureFlagsAsync,
  getFeatureFlagsLazy,
} from '~/server/services/feature-flags.service';
import { canAccessAppAssistant, resolveAppsBuildPageMode } from '~/shared/utils/app-blocks-access';
import type { SessionUser } from '~/types/session';

let nextUserId = 52_000;
const freshId = () => ++nextUserId;

const userRow = (
  id: number,
  appBuilderApproved: boolean,
  settings: unknown = {}
): ProducerUserRow => ({
  id,
  username: 'storyboarder',
  name: null,
  email: null,
  emailVerified: null,
  image: null,
  createdAt: new Date('2024-02-01T00:00:00Z'),
  isModerator: false,
  showNsfw: false,
  blurNsfw: true,
  browsingLevel: 1,
  onboarding: 0,
  muted: false,
  mutedAt: null,
  bannedAt: null,
  deletedAt: null,
  customerId: null,
  paddleCustomerId: null,
  autoplayGifs: null,
  leaderboardShowcase: null,
  filePreferences: {},
  settings,
  meta: {},
  profilePicture: null,
  referral: null,
  appBuilderApproved,
});

/** The producer row → the SessionUser a request carries. Real hub code. */
const sessionUser = (id: number, approved: boolean, settings?: unknown): SessionUser =>
  shapeSessionUser({
    row: userRow(id, approved, settings),
    subscriptionRows: [],
    permissions: [],
    roles: [],
    tierKey: 'tier',
  }) as unknown as SessionUser;

/** `app-builder-approved`: STRING_COMPARISON appBuilderApproved eq "true" (flipt-state). */
const builderApproved = (ctx?: Record<string, string>) => ctx?.appBuilderApproved === 'true';
const moderators = (ctx?: Record<string, string>) => ctx?.isModerator === 'true';

/** The flags the companion flipt-state change puts the segment on, all `enabled: false`. */
const BUILDER_FLAGS = new Set([
  'app-blocks-enabled',
  'app-listings',
  'app-blocks-get-started',
  'app-blocks-author',
  'app-assistant',
  'app-blocks-dev-tunnel',
]);

beforeEach(() => {
  mockIsFliptSync.mockReset();
  mockIsFliptSync.mockImplementation(
    (flag: string, _entityId: string, ctx?: Record<string, string>) => {
      if (!BUILDER_FLAGS.has(flag)) return null;
      // First matching rollout wins; otherwise the flag's `enabled: false`.
      return moderators(ctx) || builderApproved(ctx) ? true : false;
    }
  );
});

const req = { headers: {} } as never;

describe('app-builder grant: hub session → Flipt context', () => {
  it('an approved user’s session reaches the context as the STRING "true"', () => {
    const user = sessionUser(freshId(), true);
    expect(user.appBuilderApproved).toBe(true);
    expect(buildFliptContext(user).appBuilderApproved).toBe('true');
  });

  it('a user without an approved request reaches it as "false"', () => {
    const user = sessionUser(freshId(), false);
    expect(user.appBuilderApproved).toBeUndefined();
    expect(buildFliptContext(user).appBuilderApproved).toBe('false');
  });

  it('🔴 a settings blob cannot grant it — only the query column can', () => {
    const user = sessionUser(freshId(), false, { appBuilderApproved: true });
    expect(user.appBuilderApproved).toBeUndefined();
    expect(buildFliptContext(user).appBuilderApproved).toBe('false');
  });
});

describe.each([
  ['eager (SSR seed)', (user?: SessionUser) => getFeatureFlagsAsync({ user, req })],
  ['lazy (tRPC context)', async (user?: SessionUser) => getFeatureFlagsLazy({ user, req })],
])('app-builder grant decides the builder flags — %s', (_label, flagsFor) => {
  it('🔴 approved: the App Assistant gate admits them and /apps/build renders the assistant', async () => {
    const user = sessionUser(freshId(), true);
    const features = await flagsFor(user);
    expect(features.appAssistant).toBe(true);
    expect(features.appBlocks).toBe(true);
    expect(features.appListings).toBe(true);
    expect(features.appBlocksAuthor).toBe(true);
    expect(features.appBlocksGetStarted).toBe(true);
    expect(canAccessAppAssistant(features)).toBe(true);
    expect(resolveAppsBuildPageMode(user, features)).toBe('assistant');
  });

  it('🔴 not approved: none of the builder flags, and no assistant', async () => {
    const user = sessionUser(freshId(), false);
    const features = await flagsFor(user);
    expect(features.appAssistant).toBeFalsy();
    expect(features.appBlocksAuthor).toBeFalsy();
    expect(canAccessAppAssistant(features)).toBe(false);
    expect(resolveAppsBuildPageMode(user, features)).toBeNull();
  });

  it('the grant is not a general escalation: a mod-only flag outside the set stays off', async () => {
    const features = await flagsFor(sessionUser(freshId(), true));
    expect(features.appBlocksAgenticReview).toBeFalsy();
  });
});

describe('app-builder grant: the FeatureAccess memo key must include it', () => {
  it('🔴 approving the SAME user flips the assistant inside the 10s memo TTL, and revoking flips it back', async () => {
    // Same id, host, region, tier and permissions — only the grant differs. Without the key
    // carrying it, the refreshed session would land on the entry cached before the decision.
    const id = freshId();
    expect(
      (await getFeatureFlagsAsync({ user: sessionUser(id, false), req })).appAssistant
    ).toBeFalsy();
    expect((await getFeatureFlagsAsync({ user: sessionUser(id, true), req })).appAssistant).toBe(
      true
    );
    expect(
      (await getFeatureFlagsAsync({ user: sessionUser(id, false), req })).appAssistant
    ).toBeFalsy();
  });
});
