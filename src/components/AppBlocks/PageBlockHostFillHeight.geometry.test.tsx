/**
 * A FULL-PAGE APP BLOCK FILLS THE PHONE — MEASURED IN PIXELS.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS IS BUILT AROUND, AND WHY IT IS THE RIGHT ONE TO DEMONSTRATE
 * ─────────────────────────────────────────────────────────────────────────────
 * `app-page-content` — the app's own column inside `PageBlockHost` — carries
 * `flex: 1` because it took over the role of consuming the space the chrome
 * leaves. That property is recorded IN THE SOURCE as load-bearing and, in the
 * same breath, as uncovered by anything that renders:
 *
 *   "🔴 `flex: 1` IS THE LOAD-BEARING ONE AND NOTHING RENDERED CATCHES ITS LOSS.
 *    Measured by mutation: dropping it leaves the FULL node suite and the FULL
 *    `AppBlocks` browser suite green while the app column collapses to ~150px at
 *    a 900px content height — a running App Block reduced to a sliver, with
 *    every tier green."
 *                          — src/components/AppBlocks/PageBlockHost.tsx
 *
 * The only thing standing between that mutation and production today is a SOURCE
 * pin in the node tier (`__tests__/pageBlockHostMaxWidth.test.ts`) which asserts
 * the style block's TEXT verbatim. A source pin is a real guard and it is not the
 * same guard as this one: it cannot see a collapse caused by anything other than
 * that exact text changing — a parent losing its own height, a `min-height`
 * arriving in the cascade, an ancestor becoming `display: block` — and it has to
 * be rewritten every time the block is legitimately reformatted.
 *
 * This file asserts the CONSEQUENCE instead: at a phone viewport the app column
 * reaches the bottom of the frame it lives in. Nothing about the spelling.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT COULD NOT BE WRITTEN IN THE `component` TIER
 * ─────────────────────────────────────────────────────────────────────────────
 * Not because that tier cannot lay out — it is real headless Chromium and its
 * `getBoundingClientRect()` returns real boxes. Because of what it does and does
 * not load. Two independent reasons, both measured:
 *
 *  1. The shell chain this fixture reproduces is TAILWIND (`flex flex-1
 *     flex-col overflow-hidden`, straight out of `AppLayout`). The `component`
 *     tier loads no Tailwind utilities at all, so every one of those classes
 *     computes `display: block` there and the fixture is not a flex column — the
 *     host would have no definite parent height and the measurement would be
 *     meaningless whether or not the defect exists.
 *  2. `flex: 1` is only a HEIGHT because the container is a `column`. Without the
 *     Mantine + app cascade the container's own axis is not what production's is,
 *     so the property under test is not even on the axis being measured.
 *
 * And no viewport: the runner's silent default is 414x896, a size nothing in this
 * suite chose.
 *
 * 🔴 MEASURED, THIS EXACT FIXTURE, CORRECT SOURCE, IN BOTH TIERS (2026-09-03):
 *
 *                             `component`      `geometry`
 *   viewport                    414 x 896       390 x 844
 *   CSS rules in the document          24           3,677
 *   `<main className="flex …">`     block            flex
 *   chrome bar height                 200              31
 *   host frame height                 350             844
 *   APP COLUMN HEIGHT                 150             813
 *
 * `150` is also what the app column measures HERE with the recorded `flex: 1`
 * defect planted. So the number the `component` tier reports for CORRECT code is
 * the number the defect produces — an assertion written there could not have
 * separated them at any threshold.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES AND DOES NOT ADD OVER THE EXISTING GUARDS
 * ─────────────────────────────────────────────────────────────────────────────
 * Stated plainly, because the honest answer is not "it catches what nothing else
 * does". Both mutations below were run against the node tier as well, and BOTH
 * are caught there today by verbatim source pins:
 *
 *   · drop `flex: 1` from `app-page-content` → this file fails with the column at
 *     150px of an 844px frame; `__tests__/pageBlockHostMaxWidth.test.ts` also fails.
 *   · drop `flex: 1` from the frame's `fit === 'fill'` branch → this file fails
 *     with the column at 269px; `__tests__/pageRunScrollContract.test.ts` also fails.
 *
 * The difference is what each guard is ABLE to see. A verbatim source pin is a
 * claim about the TEXT of one file: it cannot see a collapse that arrives from
 * the cascade (a ledger entry in globals.css, a Mantine upgrade), from an
 * ancestor, or from a viewport at which the arithmetic stops working — and it has
 * to be rewritten every time the block is legitimately reformatted, which is when
 * a pin is most likely to be relaxed. This file asserts the consequence and is
 * indifferent to spelling.
 */
import { Box } from '@mantine/core';
import { describe, expect, test, vi } from 'vitest';
import type * as TrpcMod from '~/utils/trpc';
import {
  PHONE_VIEWPORT,
  box,
  cascadeEvidence,
  flexAxis,
  flexLonghands,
  renderAtViewport,
} from '../../../test/geometry-setup';

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

// Spread the REAL module and override only what this render touches
// (local-rules/no-wholesale-module-mock). A one-key mock goes stale the moment
// the module gains an export and takes the whole file to "0 tests collected".
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  setTrpcBatchingEnabled: vi.fn(),
  trpc: {
    // Collection follow/unfollow host bridge (SET_COLLECTION_FOLLOW). Both
    // hosts register the handler, so every host-rendering suite needs these
    // two session-authed mutations present on the mocked client.
    collection: {
      follow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      unfollow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    generation: { resolveWildcardPack: { useMutation: () => ({ mutateAsync: vi.fn() }) } },
    blocks: {
      submitWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyBuzzBalance: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyViewer: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyBuzzTransactions: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyBuzzAccounts: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyDailyCompensation: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      estimateWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      pollWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      cancelWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      queryAppWorkflows: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      cancelAppWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      publishGenerationOutputs: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getImagesByIds: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    apps: {
      shared: {
        append: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        update: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        vote: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        unvote: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        withdraw: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        report: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      },
      storage: {
        set: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        delete: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      },
    },
    useUtils: () => ({
      apps: {
        shared: {
          list: { fetch: vi.fn() },
          getCount: { fetch: vi.fn() },
          getCounts: { fetch: vi.fn() },
          get: { fetch: vi.fn() },
        },
        storage: {
          get: { fetch: vi.fn() },
          list: { fetch: vi.fn() },
          getQuota: { fetch: vi.fn() },
        },
      },
    }),
  },
}));

// eslint-disable-next-line import/first
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';

const SAME_ORIGIN_SRC = `${window.location.origin}/`;

const baseProps = {
  appBlockId: 'apb_fillheight',
  blockId: 'fill-height-app',
  appId: 'app_fillheight',
  blockInstanceId: 'page_apb_fillheight',
  appName: 'Fill Height App',
  iframeSrc: SAME_ORIGIN_SRC,
  surface: 'page-run' as const,
  bootSkeleton: false,
  sandbox: 'allow-scripts',
  trustTier: 'internal' as const,
  slug: 'fill-height-app',
  token: 'tok_fillheight',
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  declaredScopes: [] as string[],
  missingScopes: [] as string[],
  needsConsent: false,
  tokenError: false,
  viewer: null,
  theme: 'light' as const,
};

/**
 * The production chain, reduced to what decides HEIGHT.
 *
 * Reproduces `AppLayout`'s no-scroll branch verbatim, in ITS OWN CLASSES —
 * `MainContent`'s `no-scroll group flex flex-1 flex-col overflow-hidden` and the
 * `<main className="flex flex-1 flex-col overflow-hidden">` inside it — followed
 * by the run page's own wrapper `Box`. Copying the classes rather than
 * paraphrasing them into inline styles is deliberate: the chain's behaviour IS
 * those utilities, and a paraphrase would be a fixture asserting against itself.
 *
 * The outermost element is given the viewport's own height, because in
 * production that box is the document and `scrollable: false` makes the whole
 * column exactly one screen tall.
 */
function renderRunPageChain() {
  return renderAtViewport(
    <div
      data-testid="shell-root"
      className="flex flex-col"
      style={{ height: PHONE_VIEWPORT.height }}
    >
      <div className="flex flex-1 overflow-hidden">
        <div className="no-scroll group flex flex-1 flex-col overflow-hidden">
          <main data-testid="layout-main" className="flex flex-1 flex-col overflow-hidden">
            <Box
              data-testid="page-wrapper"
              style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
            >
              <PageBlockHost {...baseProps} fit="fill" />
            </Box>
          </main>
        </div>
      </div>
    </div>,
    PHONE_VIEWPORT
  );
}

function el(testid: string): HTMLElement {
  const node = document.querySelector(`[data-testid="${testid}"]`);
  if (!node) throw new Error(`geometry fixture: no element with data-testid="${testid}"`);
  return node as HTMLElement;
}

describe('PageBlockHost — the app column fills the phone', () => {
  /**
   * 🔴 GUARD THE INSTRUMENT BEFORE READING IT.
   *
   * Every claim below is "this box is as tall as that box", which a fixture that
   * is not a flex column satisfies for the wrong reason — or fails for the wrong
   * reason, which is worse, because it reads as the defect. So the viewport, the
   * cascade and the fixture's own axis are asserted first, each against a value
   * that cannot be produced without the thing it is checking.
   */
  test('POSITIVE CONTROL — a 390x844 phone, a loaded cascade, and a real flex column', async () => {
    const { observed } = await renderRunPageChain();

    expect(observed).toEqual({ width: 390, height: 844 });

    const evidence = cascadeEvidence();
    expect(
      evidence.ruleCount,
      `only ${evidence.ruleCount} CSS rules are loaded — this file is measuring an unstyled document`
    ).toBeGreaterThan(500);
    expect(evidence.tailwindFlexUtilityResolves).toBe(true);

    // The fixture's own chain. `flex flex-1 flex-col` is Tailwind, so in a tier
    // without the utility layer each of these is `display: block` and `flexAxis`
    // returns `'none'`.
    expect(
      flexAxis(el('shell-root')),
      'the shell root is not a flex column — the Tailwind utility layer is not applied and this ' +
        'fixture is not the chain it claims to reproduce'
    ).toBe('column');
    expect(flexAxis(el('layout-main'))).toBe('column');
    expect(flexAxis(el('page-wrapper'))).toBe('column');
    expect(flexAxis(el('app-page-content'))).toBe('column');

    // And the chain really has a definite height to distribute — without this,
    // "the content fills the frame" is true of two zero-height boxes.
    expect(box(el('shell-root')).height).toBe(844);
    expect(box(el('page-wrapper')).height).toBeGreaterThan(700);
  });

  /**
   * 🔴 THE REGRESSION CLAIM — asserted as PIXELS, on a RELATIONSHIP.
   *
   * Two boxes, in the right order:
   *   · `app-page-frame`   — the host root; carries the chrome bar and spans the page.
   *   · `app-page-content` — the app's own column, which must consume everything the
   *                          chrome leaves.
   *
   * The pair is what makes this coverage rather than an invariant guard. "The
   * content has a height" alone is green on the mutant (150px is a height);
   * "the content's bottom edge is the frame's bottom edge" is not, and cannot be
   * satisfied by a column that stopped growing.
   */
  test('the app column reaches the bottom of the frame at 390x844', async () => {
    await renderRunPageChain();

    const frame = box(el('app-page-frame'));
    const content = box(el('app-page-content'));
    const chrome = box(el('app-block-chrome'));

    // The headline. A collapsed column's bottom sits far above the frame's.
    expect(
      content.bottom,
      `the app column ends at y=${content.bottom} inside a frame that ends at y=${frame.bottom} — ` +
        `${Math.round(frame.bottom - content.bottom)}px of the phone is blank below a running ` +
        `App Block. The column measured ${content.height}px of the frame's ${frame.height}px, ` +
        `with flex longhands ${JSON.stringify(flexLonghands(el('app-page-content')))}.`
    ).toBeCloseTo(frame.bottom, 1);

    // The same fact stated as an amount, so a failure names the sliver rather
    // than a coordinate. Frame minus chrome is exactly what `flex: 1` claims.
    expect(
      content.height,
      `the app column is ${content.height}px tall; the frame is ${frame.height}px and the chrome ` +
        `bar above it is ${chrome.height}px, so the column should be ` +
        `${Math.round((frame.height - chrome.height) * 100) / 100}px.`
    ).toBeCloseTo(frame.height - chrome.height, 1);

    // 🔴 A LITERAL FLOOR, deliberately not derived from any constant this render
    // produced. The recorded mutant collapses the column to ~150px; at an 844px
    // viewport the healthy value is ~800. 600 sits between the two with room on
    // both sides, and — unlike the two comparisons above — it survives a mutation
    // that shrinks the FRAME as well as the content, which would keep them equal.
    expect(
      content.height,
      `the app column is ${content.height}px tall on an 844px-high phone — a running App Block ` +
        'reduced to a sliver'
    ).toBeGreaterThan(600);
  });

  /**
   * The second measurement point. A single viewport cannot distinguish "fills its
   * parent" from "happens to be 800px tall", and a floor written at one height is
   * exactly the kind of number that stops meaning anything when the harness's
   * default moves.
   */
  test('it fills a SHORTER phone too — the column tracks the viewport, not a constant', async () => {
    const shortPhone = { width: 390, height: 640 } as const;
    const { observed } = await renderAtViewport(
      <div className="flex flex-col" style={{ height: shortPhone.height }}>
        <div className="flex flex-1 overflow-hidden">
          <div className="no-scroll group flex flex-1 flex-col overflow-hidden">
            <main className="flex flex-1 flex-col overflow-hidden">
              <Box style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
                <PageBlockHost {...baseProps} fit="fill" />
              </Box>
            </main>
          </div>
        </div>
      </div>,
      shortPhone
    );

    expect(observed).toEqual({ width: 390, height: 640 });

    const frame = box(el('app-page-frame'));
    const content = box(el('app-page-content'));
    const chrome = box(el('app-block-chrome'));

    expect(content.bottom).toBeCloseTo(frame.bottom, 1);
    expect(content.height).toBeCloseTo(frame.height - chrome.height, 1);
    // 640 - chrome, so materially SHORTER than the 844 case: the column is not a
    // constant that happened to clear the floor above.
    expect(content.height).toBeGreaterThan(400);
    expect(content.height).toBeLessThan(640);
  });
});
