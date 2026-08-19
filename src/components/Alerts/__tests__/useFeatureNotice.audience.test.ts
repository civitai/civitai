// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import type * as Trpc from '~/utils/trpc';
import type { FeatureNotice } from '~/components/Alerts/notice-registry';

const act = (React as unknown as { act: typeof actType }).act;

// Tells React this is an act-aware environment, so the renders below don't each
// log "not configured to support act(...)". Purely output noise; nothing about
// what is asserted depends on it.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 🔴 AUDIENCE TARGETING, ASSERTED AS RETURNED BEHAVIOUR — and asserted HERE, in
 * the `unit` project, deliberately.
 *
 * The notice components are covered by `*.browser.test.tsx` files, which are a
 * separate Vitest project (`component`, real Chromium). CI runs
 * `vitest run --project unit`. A browser-only assertion is therefore reassurance
 * and not a gate, so the load-bearing claim — *a targeted notice is not offered
 * to a non-member and is offered to a member* — lives in a `.test.ts` that the
 * blocking job executes. `happy-dom` + `react-dom/client` is the pattern this
 * repo already uses to render a hook in the node project (see
 * `useDailyBoostReward.test.ts`).
 *
 * What every test below reads is the hook's RETURN VALUE, never the registry
 * field. `notice.audience` existing proves nothing; phase 1's warning was
 * precisely that "an unread field on a definition looks like a gate and gates
 * nothing". Deleting the branch in `isNoticeAudienceMatched` has to turn these
 * red, and the mutation was run: see the PR description.
 *
 * FIXTURES. The notices are hand-built rather than taken from the registry, so
 * the cases stay pairwise distinct and stay distinct from `remixGallery` — the
 * one constant the registry names. A fixture that could only ever be the
 * production value cannot catch a mutant that hardcodes the production value.
 * `TARGETED_ON` and `TARGETED_OFF` name DIFFERENT flags, and the flag map below
 * gives them DIFFERENT answers, so an implementation that ignores
 * `audience.feature` and returns "some flag was true" fails.
 */

let dismissedAlerts: string[] | undefined;
let settingsResolved = true;
let flags: Record<string, boolean> | null;
let flagsReady: boolean;
let currentUser: { id: number } | null;
const dismissMutate = vi.fn();

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: {
    useUtils: () => ({
      user: {
        getSettings: {
          cancel: vi.fn(),
          getData: vi.fn(),
          setData: vi.fn(),
          invalidate: vi.fn(),
        },
      },
    }),
    user: {
      getSettings: {
        // `enabled` is honoured rather than ignored: the hook disables this
        // query without a signed-in user, so a mock that always returns data
        // would report `hasSettings: true` for a visitor production leaves at
        // `false` — and the signed-out case below asserts against it.
        useQuery: (_input?: unknown, opts?: { enabled?: boolean }) => ({
          data: settingsResolved && (opts?.enabled ?? true) ? { dismissedAlerts } : undefined,
          isLoading: false,
        }),
      },
      dismissAlert: { useMutation: () => ({ mutate: dismissMutate }) },
    },
  },
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => currentUser }));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useOptionalFeatureFlags: () => flags,
  useFeatureFlagsReady: () => flagsReady,
}));

const { useFeatureNotice } = await import('~/components/Alerts/useFeatureNotice');

/** Two targeted notices naming DIFFERENT flags, and one that names none. */
const TARGETED_ON: FeatureNotice = {
  id: 'fixture-notice-alpha',
  audience: { feature: 'imageCardInfoButton' },
};
const TARGETED_OFF: FeatureNotice = {
  id: 'fixture-notice-beta',
  audience: { feature: 'appReviewPage' },
};
const UNTARGETED: FeatureNotice = { id: 'fixture-notice-gamma' };

/**
 * The flag answers. `imageCardInfoButton` on, `appReviewPage` off — so "is the
 * user in THIS notice's audience" and "is the user in ANY audience" give
 * different answers, and only the first one passes.
 */
const FLAGS = { imageCardInfoButton: true, appReviewPage: false };

function readHook(notice: FeatureNotice) {
  let result: ReturnType<typeof useFeatureNotice> | undefined;
  const Probe = () => {
    result = useFeatureNotice(notice);
    return null;
  };
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => root.render(React.createElement(Probe)));
  act(() => root.unmount());
  return result!;
}

/** What a call site actually composes. This is the claim that matters. */
const wouldRender = (notice: FeatureNotice) => {
  const { hasSettings, isDismissed, isInAudience } = readHook(notice);
  return hasSettings && !isDismissed && isInAudience;
};

beforeEach(() => {
  vi.clearAllMocks();
  dismissedAlerts = [];
  settingsResolved = true;
  currentUser = { id: 91 };
  flags = { ...FLAGS };
  flagsReady = true;
});

describe('a targeted notice reaches its audience and nobody else', () => {
  test('NOT offered to a user the notice’s flag is off for', () => {
    expect(wouldRender(TARGETED_OFF)).toBe(false);
    expect(readHook(TARGETED_OFF).isInAudience).toBe(false);
  });

  test('offered to a user the notice’s flag is on for', () => {
    expect(wouldRender(TARGETED_ON)).toBe(true);
    expect(readHook(TARGETED_ON).isInAudience).toBe(true);
  });

  test('the SAME user gets opposite answers for the two notices', () => {
    // One render pass, one flag map, two notices. An implementation that
    // ignores `audience.feature` — returning a constant, or "any flag is on" —
    // cannot produce two different answers here.
    expect(readHook(TARGETED_ON).isInAudience).toBe(true);
    expect(readHook(TARGETED_OFF).isInAudience).toBe(false);
  });

  test('a flag absent from the overlay is not an audience', () => {
    // Absent, not false. `undefined` must not read as membership.
    flags = { imageCardInfoButton: true };
    expect(wouldRender(TARGETED_OFF)).toBe(false);
  });

  test('membership does not resurrect a dismissed notice', () => {
    // The two gates are independent: being in the audience is not permission to
    // re-show something the user closed.
    dismissedAlerts = ['fixture-notice-alpha'];
    expect(wouldRender(TARGETED_ON)).toBe(false);
    expect(readHook(TARGETED_ON).isInAudience).toBe(true);
  });
});

describe('a targeted notice fails CLOSED while the answer is unknown', () => {
  test('not offered before the per-user flag overlay has resolved', () => {
    // The flags present are the anonymous server snapshot until `ready`.
    // Announcing against those and retracting is the flash the notice
    // machinery exists to avoid.
    flagsReady = false;
    expect(wouldRender(TARGETED_ON)).toBe(false);
  });

  test('not offered when there is no flag provider at all', () => {
    flags = null;
    expect(wouldRender(TARGETED_ON)).toBe(false);
  });

  test('a SIGNED-OUT visitor is in no audience, however ready the flags claim to be', () => {
    // 🔴 `flagsReady` cannot close this one. It is
    // `!session.data || isSuccess || isError`, so logged out it is `true` BY
    // CONSTRUCTION — against the anonymous snapshot. A pure
    // `isNoticeAudienceMatched` handed those two arguments cannot tell that
    // apart from a resolved per-user answer, so the hook ANDs in `!!currentUser`
    // and this pins it.
    //
    // Belt-and-braces rather than the only guard: `hasSettings` is already
    // false signed out (the settings query is disabled without a user), which
    // is why this changes nothing at any call site composing as documented.
    currentUser = null;
    flags = { imageCardInfoButton: true };
    flagsReady = true;
    expect(readHook(TARGETED_ON).isInAudience).toBe(false);
    expect(wouldRender(TARGETED_ON)).toBe(false);
    // The other gate that already covered this, asserted separately so the two
    // claims do not collapse into one.
    expect(readHook(TARGETED_ON).hasSettings).toBe(false);
  });
});

describe('an untargeted notice behaves exactly as it did before targeting existed', () => {
  // 🔴 SCOPE HONESTY: these are INVARIANT guards, not regression tests. They
  // pin that the eight notices carrying no `audience` are untouched by the
  // field's introduction. They stay green with the audience branch deleted —
  // that is the point of them, and it is why they are not the mutation
  // evidence.
  test('offered even though every flag in the overlay is off', () => {
    flags = { imageCardInfoButton: false, appReviewPage: false };
    expect(wouldRender(UNTARGETED)).toBe(true);
  });

  test('offered before the flag overlay resolves', () => {
    flagsReady = false;
    expect(wouldRender(UNTARGETED)).toBe(true);
  });

  test('offered with no flag provider at all', () => {
    flags = null;
    expect(wouldRender(UNTARGETED)).toBe(true);
  });

  test('still hidden once dismissed, and still hidden before settings resolve', () => {
    dismissedAlerts = ['fixture-notice-gamma'];
    expect(wouldRender(UNTARGETED)).toBe(false);

    dismissedAlerts = [];
    settingsResolved = false;
    expect(wouldRender(UNTARGETED)).toBe(false);
    // `hasSettings`, not `isLoading`: the query has settled (isLoading false)
    // with no data, which is the errored-fetch shape. It must not render.
    expect(readHook(UNTARGETED).isLoading).toBe(false);
    expect(readHook(UNTARGETED).hasSettings).toBe(false);
  });
});

describe('the dismissal path is unchanged by targeting', () => {
  test('dismiss sends the notice’s own id', () => {
    readHook(TARGETED_ON).dismiss();
    expect(dismissMutate).toHaveBeenCalledWith({ alertId: 'fixture-notice-alpha' });
  });

  test('restore sends the notice’s own id with dismiss false', () => {
    readHook(TARGETED_OFF).restore();
    expect(dismissMutate).toHaveBeenCalledWith({
      alertId: 'fixture-notice-beta',
      dismiss: false,
    });
  });
});
