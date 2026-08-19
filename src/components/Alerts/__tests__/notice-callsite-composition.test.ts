// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import type * as Trpc from '~/utils/trpc';

const act = (React as unknown as { act: typeof actType }).act;

// Tells React this is an act-aware environment, so the renders below don't each
// log "not configured to support act(...)". Purely output noise.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 🔴 THE CALL SITE'S COMPOSITION, RENDERED — in the `unit` project, which is the
 * only one CI runs.
 *
 * WHY THIS FILE EXISTS. Three suites already cover audience targeting and none
 * of them could see the defect this one is for:
 *
 * - `useFeatureNotice.audience.test.ts` asserts the HOOK'S RETURN VALUE. A hook
 *   can only offer an answer; it says nothing about whether a call site applies
 *   it.
 * - `notice-callsite-coverage.test.ts` greps the call site for the token
 *   `isInAudience`. That is a SPELLED guard — it is satisfied by the
 *   destructure alone, so deleting `&& !isInAudience` from the render condition
 *   while leaving `isInAudience` bound at line 38 keeps it green. The audience
 *   is then computed and thrown away, and every notice ships to every user who
 *   reaches the component.
 * - `notice-callsite.browser.test.tsx` does assert the rendered DOM, but it is
 *   in the `component` project, which CI does NOT run. It is corroboration.
 *
 * The verified surviving mutant was exactly that: destructure kept, `&&
 * !isInAudience` removed from `RemixGalleryExplainer`'s render guard, whole
 * `unit` project green. This file renders the REAL component through the REAL
 * hook and the REAL registry entry and asserts what reached the DOM, so the
 * behaviour — not the word — is what is pinned.
 *
 * WHY `.test.ts` AND NOT `.test.tsx`: the `unit` project's include is
 * `src/**\/*.test.ts`, so a `.tsx` file is silently not collected. Hence
 * `React.createElement` rather than JSX. `happy-dom` + `react-dom/client` is the
 * pattern this repo already uses to render in the node project (see
 * `useDailyBoostReward.test.ts` and `useFeatureNotice.audience.test.ts`).
 *
 * FIXTURE HONESTY: `remixGallery` here is NOT a free choice — it is the flag the
 * registry names for this notice, and asserting against the real registry entry
 * is the point of a composition test. The "unrelated flag" case below uses a
 * different flag so that "reads its own audience" stays separable from "some
 * flag was on".
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
        // `enabled` honoured, not ignored: the hook disables this query without
        // a signed-in user, so an always-answering mock would hand the
        // signed-out case a `hasSettings` production never gives it.
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

const { RemixGalleryExplainer } = await import('~/components/RemixGallery/RemixGalleryExplainer');
const { MantineProvider } = await import('@mantine/core');

/**
 * A fragment of the explainer's own copy. Hand-typed rather than imported, so a
 * rewrite of the component's markup cannot make this agree with itself.
 */
const NOTICE_COPY = "What's a remix gallery?";

/** Marks the tree as having mounted at all. */
const SENTINEL_ID = 'composition-sentinel';

type Rendered = {
  /** Dismiss affordances the notice rendered. 1 when shown, 0 when withheld. */
  dismissControls: number;
  /** Whether the notice's own copy reached the DOM. */
  showsCopy: boolean;
  /**
   * Whether the surrounding tree mounted. Without this, "the notice is absent"
   * is indistinguishable from "the render threw and nothing exists" — an
   * assertion that would pass for the wrong reason forever.
   */
  mounted: boolean;
};

function renderCallSite(): Rendered {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(RemixGalleryExplainer),
        React.createElement('span', { 'data-testid': SENTINEL_ID }, 'mounted')
      )
    )
  );
  const result: Rendered = {
    dismissControls: container.querySelectorAll('[aria-label="Dismiss"]').length,
    showsCopy: (container.textContent ?? '').includes(NOTICE_COPY),
    mounted: !!container.querySelector(`[data-testid="${SENTINEL_ID}"]`),
  };
  act(() => root.unmount());
  container.remove();
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  dismissedAlerts = [];
  settingsResolved = true;
  currentUser = { id: 91 };
  flags = { remixGallery: true };
  flagsReady = true;
});

describe('RemixGalleryExplainer applies its audience to what it renders', () => {
  test('renders for a user the notice’s flag is ON for', () => {
    // 🔴 The positive control, and it comes first deliberately: every assertion
    // below is "the notice is absent", which a component that renders nothing
    // ever would also satisfy.
    const { dismissControls, showsCopy, mounted } = renderCallSite();
    expect(mounted).toBe(true);
    expect(showsCopy).toBe(true);
    expect(dismissControls).toBe(1);
  });

  test('renders NOTHING for a user the notice’s flag is OFF for', () => {
    // 🔴 THE MUTANT-KILLING CASE. Deleting `&& !isInAudience` from the render
    // guard — while leaving `isInAudience` destructured, which is what keeps the
    // token-scanning ledger green — makes this render the full notice.
    flags = { remixGallery: false };
    const { dismissControls, showsCopy, mounted } = renderCallSite();
    expect(mounted, 'the tree did not mount at all, so an absent notice proves nothing here').toBe(
      true
    );
    expect(
      showsCopy,
      'the explainer announced the remix gallery to a user the `remixGallery` flag is OFF for. ' +
        'The hook computed `isInAudience`, and the call site did not APPLY it — AND ' +
        '`!isInAudience` back into the render condition in RemixGalleryExplainer.tsx.'
    ).toBe(false);
    expect(dismissControls).toBe(0);
  });

  test('a flag absent from the overlay is not an audience', () => {
    // Absent, not false. `undefined` must not read as membership.
    flags = {};
    const { showsCopy, mounted } = renderCallSite();
    expect(mounted).toBe(true);
    expect(showsCopy).toBe(false);
  });

  test('an unrelated flag being ON does not put a user in the audience', () => {
    // Separates "reads its own audience" from "some flag was on". A mutant that
    // ignores `audience.feature` passes the case above and fails this one.
    flags = { remixGallery: false, imageCardInfoButton: true };
    const { showsCopy, dismissControls } = renderCallSite();
    expect(showsCopy).toBe(false);
    expect(dismissControls).toBe(0);
  });
});

describe('RemixGalleryExplainer fails CLOSED while the audience is unknown', () => {
  test('renders nothing before the per-user flag overlay has resolved', () => {
    // The flags present are the anonymous server snapshot until `ready`.
    // Announcing against those and retracting is the flash the notice machinery
    // exists to avoid.
    flagsReady = false;
    const { showsCopy, mounted } = renderCallSite();
    expect(mounted).toBe(true);
    expect(showsCopy).toBe(false);
  });

  test('renders nothing when there is no flag provider at all', () => {
    flags = null;
    const { showsCopy, mounted } = renderCallSite();
    expect(mounted).toBe(true);
    expect(showsCopy).toBe(false);
  });
});

describe('the audience gate is independent of the other two', () => {
  test('membership does not resurrect a dismissed notice', () => {
    dismissedAlerts = ['remix-gallery-explainer'];
    const { showsCopy, mounted } = renderCallSite();
    expect(mounted).toBe(true);
    expect(showsCopy).toBe(false);
  });

  test('membership does not render against an unresolved settings object', () => {
    // `hasSettings`, not `isLoading`: the query has settled with no data, which
    // is the errored-fetch shape.
    settingsResolved = false;
    const { showsCopy, mounted } = renderCallSite();
    expect(mounted).toBe(true);
    expect(showsCopy).toBe(false);
  });

  test('membership does not show the notice to a signed-out visitor', () => {
    // Signed out there is nowhere to record a dismissal, so showing it would
    // mean showing it forever.
    currentUser = null;
    const { showsCopy, mounted } = renderCallSite();
    expect(mounted).toBe(true);
    expect(showsCopy).toBe(false);
  });
});
