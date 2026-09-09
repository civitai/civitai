// 🔴 THIS FILE ASSERTS PIXELS, SO IT LOADS THE REAL CASCADE — see the header note
// "WHY THIS FILE LOADS THE STYLESHEET" below before removing this line.
import '@mantine/core/styles.css';
import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
// Type-only namespace import for the `importOriginal` spread below (the repo's
// local-rules/no-wholesale-module-mock cure). NOT `typeof import(...)`, which
// @typescript-eslint/consistent-type-imports rejects.
import type * as TrpcMod from '~/utils/trpc';

/**
 * IframeHost — layer 4 of the height defense: the VIEWPORT clamp
 * (`model.sidebar_top`, the inline model-page slot).
 *
 * THE GAP. `applyHeight` had three layers: the `isFinite`/positive value guard,
 * `manifest.iframe.maxHeight`, and `HARD_HEIGHT_CEILING` (8000). But
 * `public/schemas/app-block/v1.json` types `iframe.maxHeight` as
 * `["integer","null"]` and `iframe` declares NO required fields, so a manifest
 * that simply OMITS `maxHeight` is bounded only at 8000px. A block
 * self-reporting 3000px therefore got a 3000px-tall iframe inside a ~640px
 * phone viewport — the slot swallowed the page. Layer 4 bounds the block's
 * stated height to `Math.max(minHeight, viewport − overhead)`, where the
 * overhead is the host chrome plus the frame's own borders; the block scrolls
 * internally instead, which is the intended outcome.
 *
 * 🔴 WHAT LAYER 4 DOES NOT BOUND, SO NO ONE READS THESE CASES AS WIDER THAN THEY
 * ARE: the publisher's own `iframe.minHeight`. `Math.max(min, …)` means the
 * manifest floor always wins, and nothing in this change bounds it: the
 * validator (`HEIGHT_MAX_CEILING`,
 * `src/server/services/block-manifest-validator.service.ts`) permits `minHeight`
 * up to 4000, at which one schema-legal field reproduces this defect in full —
 * measured, a 4000px slot on a 640px screen with the clamp present. Even at
 * modest values it bites: over the complete approved population (11 of 11) the
 * floors are 400 x1 / 600 x5 / 640 x3 / 700 x2, and at a 640px viewport the
 * budget is 640 - 33 = 607, so the 640-tier (x3) and the 700-tier (x2) are bound
 * by their OWN floor and overflow by 33px and 93px — 5 of 11. The 400- and
 * 600-tiers fit. Capping the floor is a manifest-CONTRACT change with
 * byte-mirrors outside this repo and is tracked separately; it would not close
 * that residue anyway. Every case below fixes a modest `minHeight` and varies
 * what the BLOCK states, which is the surface layer 4 actually governs.
 *
 * 🔴 ASSERT THE FRAME, NOT THE IFRAME. `framed()` renders AppBlockChrome above
 * the iframe inside one bordered box, so a viewport-sized IFRAME is a
 * `viewport + chrome + borders` WIDGET. Measured at 390x640 with the stylesheet
 * loaded: chrome 31, frame borders 1px each, so the overhead is 33 and a
 * pre-fix 3000px report gives a 3033px widget. An iframe-only assertion passes
 * that straight through, which is exactly how the first version of this suite
 * did.
 *
 * 🔴 WHY THIS FILE LOADS THE STYLESHEET, AND WHY THAT IS NOT A CONTRADICTION OF
 * THE SIBLING'S RULE. `AppBlockChromeResponsive.browser.test.tsx` says its
 * siblings MUST NOT import `@mantine/core/styles.css` — and that rule is scoped
 * to suites asserting ATTRIBUTES AND ARIA, which is what the shared scaffold is
 * built for. This suite asserts PIXELS, so it is the same exception that file
 * takes for itself, for the same stated reason: "without it each computes to
 * something meaningless while the assertions still pass". Browser mode runs each
 * file in its own iframe, so the import cannot leak sideways.
 *
 * 🔴 IT IS NOT COSMETIC — MEASURED. Without the stylesheet this suite reported a
 * chrome overhead of 98 and a frame border of ZERO (the `Box`'s
 * `border: 1px solid var(--mantine-color-default-border)` is
 * invalid-at-computed-value-time with no cascade), and every assertion still
 * passed because they are all self-relative. The published residue table was
 * computed from that 98 and was wrong in a way that mattered: it claimed the
 * 600-tier — FIVE of the eleven live blocks — does not fit, when at the real
 * budget of 607 it does. `renderReady` now asserts the sheet is loaded, so this
 * file cannot silently slide back into the meaningless harness.
 *
 * The longer-term home for pixel assertions is the `geometry` vitest project
 * added by #4601 (`.geometry.test.tsx` + `test/geometry-setup.tsx`), which loads
 * the real cascade by construction. This file stays in `component` because it is
 * mostly a postMessage/handshake suite that happens to assert geometry, and it
 * needs the component scaffold's mocks; the single import buys the same
 * correctness here.
 *
 * 🔴 THE HARNESS WILL MAKE THIS FILE PASS VACUOUSLY IF YOU LET IT. Vitest's
 * browser default viewport is 414x896 (measured: `resolved.browser.viewport
 * .height ??= 896` in vitest's config resolution), and `test/component-setup
 * .tsx` sets none. At 896px tall, every height any neighbouring IframeHost suite
 * asserts (640, 700, 800) is already UNDER the bound, so the clamp never fires
 * and a test written without `page.viewport(...)` cannot tell layer 4 from its
 * absence. Every test here goes through `setViewport`, which calls
 * `page.viewport(...)` and then re-reads `window.innerHeight` so a viewport that
 * silently did not take is a failure rather than a green.
 *
 * 🔴 THIS SUITE IS THE WHOLE COVERAGE, AND DELIBERATELY SO. `IframeHost` is the
 * only `RESIZE_IFRAME` consumer in `src/`; the full-page sibling
 * `PageBlockHost` (`/apps/run/<slug>`) has no RESIZE_IFRAME handling at all and
 * is already viewport-bound by its own `calc(100dvh - HEADER_HEIGHT_PX)`. So
 * layer 4 is an inline-slot property, not a shared-surface one, and there is no
 * parity file to mirror.
 *
 * Mocks mirror `IframeHostThemeChange.browser.test.tsx` (the model-slot
 * scaffold): the two tRPC queries IframeHost drives at render must report
 * `isLoading: false` so the init handshake is allowed to start.
 */
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

// 🔴 `useOptionalFeatureFlags` IS LISTED TOO, AND OMITTING IT BREAKS THE WHOLE FILE.
// This factory REPLACES the module, so it must name every export anything in this
// file's module graph imports. The app-block chrome's breadcrumb crumb reads
// `useOptionalFeatureFlags` for its store gate (the non-throwing variant, because
// the chrome renders outside a provider); a factory naming only `useFeatureFlags`
// fails the LINK, not a test — nothing is collected and the run reports failing
// FILES with zero failing assertions. Read the file count, not the test count.
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: false, appBlocksPages: false }),
  useOptionalFeatureFlags: () => ({ appBlocks: false, appBlocksPages: false }),
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: {
    // Collection follow/unfollow host bridge (SET_COLLECTION_FOLLOW). Both
    // hosts register the handler, so every host-rendering suite needs these
    // two session-authed mutations present on the mocked client.
    collection: {
      follow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      unfollow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    blocks: {
      getEffectiveCheckpoint: {
        useQuery: () => ({ data: { checkpoint: null }, isLoading: false }),
      },
      getShowcaseImages: {
        useQuery: () => ({ data: [], isLoading: false }),
      },
      submitWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      estimateWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      pollWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      cancelWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      updateUserSettings: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyBuzzBalance: { useMutation: () => ({ mutateAsync: vi.fn() }) },
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

vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', () => ({
  useBrowsingLevelDebounced: () => 1,
}));

// eslint-disable-next-line import/first
import { IframeHost } from '~/components/AppBlocks/IframeHost';
// eslint-disable-next-line import/first
import type { BlockInstall, ModelSlotContext } from '~/components/AppBlocks/types';

const SAME_ORIGIN_SRC = `${window.location.origin}/`;

/**
 * Fixture geometry. Every number is distinct from every other AND from every
 * constant the assertions or the SOURCE name, so no assertion can be satisfied
 * by a collision:
 *
 *   PHONE_H  640  — the bound under test.
 *   TALL_H   900  — a second viewport, for the re-clamp on resize.
 *   REPORT   3000 — what the block claims. Well OVER 640 (so the clamp is
 *                   demonstrably what acts) and well UNDER HARD_HEIGHT_CEILING
 *                   (8000), so layer 3 cannot be what produces a pass.
 *   SHORT    400  — under both viewports, so the clamp must NOT fire.
 *   MIN_H    160  — the manifest floor.
 * `maxHeight` is ABSENT: that omission is the gap this file exists for.
 *
 * 🔴 MIN_H IS 160 AND NOT 200 FOR A MEASURED REASON. The source defaults the
 * floor with `install.manifest.iframe?.minHeight ?? 200`, so a fixture floor of
 * 200 is numerically identical to the source's own literal — and a mutant that
 * replaces the `min` argument with a hardcoded `200` then SURVIVES the whole
 * file (6 passed). 160 makes the fixture value and the source literal disagree,
 * which is the only thing that can see that mutant.
 */
const PHONE: [number, number] = [390, 640];
const PHONE_H = 640;
const TALL: [number, number] = [390, 900];
const TALL_H = 900;
const REPORT = 3000;
const SHORT = 400;
const MIN_H = 160;

function makeInstall(iframeOverrides: Record<string, unknown> = {}): BlockInstall {
  return {
    blockInstanceId: 'inst_test',
    blockId: 'my-model-app',
    appId: 'app_test',
    appBlockId: 'apb_test',
    manifest: {
      name: 'Background Remover',
      scopes: ['ai:write:budgeted'],
      iframe: {
        src: SAME_ORIGIN_SRC,
        minHeight: MIN_H,
        // NO maxHeight — the manifest shape the clamp exists for.
        resizable: true,
        sandbox: 'allow-scripts',
        ...iframeOverrides,
      },
    },
    publisherSettings: {},
    enabled: true,
    renderMode: 'iframe',
    trustTier: 'internal',
  } as BlockInstall;
}

const context: ModelSlotContext = {
  slotId: 'model.sidebar_top',
  entityType: 'model',
  modelId: 123,
  modelVersionId: 456,
  modelName: 'Some Model',
  modelType: 'Checkpoint',
  modelNsfwLevel: 1,
  creatorUserId: 7,
  viewerUserId: 42,
  viewerNsfwEnabled: false,
  viewerUsername: 'tester',
  theme: 'light',
};

const iframeEl = () => page.getByTestId('block-iframe').element() as HTMLIFrameElement;
const iframeQuery = () => page.getByTestId('block-iframe').query() as HTMLIFrameElement | null;
const frameEl = () => page.getByTestId('app-block-frame').element() as HTMLElement;
const chromeEl = () => page.getByTestId('app-block-chrome').element() as HTMLElement;

/** The height the host has actually written onto the iframe element. */
function appliedHeight(): number {
  return Number.parseFloat(iframeEl().style.height);
}

/**
 * 🔴 THE OBSERVABLE THAT MATTERS — the LAID-OUT height of the whole widget the
 * viewer sees, chrome bar included.
 *
 * `appliedHeight()` above reads the iframe alone, and an iframe-only assertion
 * is exactly how the first version of this suite passed while the widget still
 * overflowed the screen: at 390x640 the iframe was a correct 640 and the frame
 * was 673. Anything claiming "fits the viewport" must assert THIS number.
 */
function frameHeight(): number {
  return frameEl().getBoundingClientRect().height;
}

/** The host chrome's own laid-out height — measured, never assumed (31 at 390px). */
function chromeHeight(): number {
  return chromeEl().getBoundingClientRect().height;
}

/**
 * The frame's own top+bottom border, measured from the cascade (1px each).
 *
 * 🔴 NOT DECORATION — it is 2 of the 33px the clamp has to subtract, and leaving
 * it out is how the budget assertions below would be wrong by exactly that much.
 * It is also the half that is INVISIBLE without `@mantine/core/styles.css`:
 * `border: 1px solid var(--mantine-color-default-border)` is
 * invalid-at-computed-value-time with no cascade, so it computes to 0 and the
 * omission hides itself.
 *
 * Read from `getComputedStyle` rather than as `frameHeight() - appliedHeight()`
 * on purpose: that subtraction is the implementation's OWN arithmetic, so an
 * expectation built from it would be vacuously true. Chrome height plus border
 * width are independent observables.
 */
function frameBorderPx(): number {
  const cs = getComputedStyle(frameEl());
  return Number.parseFloat(cs.borderTopWidth) + Number.parseFloat(cs.borderBottomWidth);
}

/** The height budget layer 4 should leave the iframe, derived independently. */
function expectedBudget(viewportHeight: number): number {
  return viewportHeight - chromeHeight() - frameBorderPx();
}

function postFromBlock(type: string, payload?: unknown) {
  const cw = iframeEl().contentWindow;
  if (!cw) throw new Error('iframe contentWindow missing');
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type, payload },
      origin: window.location.origin,
      source: cw,
    })
  );
}

async function waitForMount() {
  await vi.waitFor(() => {
    const el = iframeQuery();
    if (!el?.contentWindow) throw new Error('not mounted yet');
  });
}

async function driveToReady(payload: unknown = {}) {
  await waitForMount();
  await vi.waitFor(() => {
    postFromBlock('BLOCK_READY', payload);
    if (iframeEl().getAttribute('data-block-ready') !== 'true') throw new Error('not ready yet');
  });
}

/**
 * 🔴 THE CONTROL THAT STOPS THIS FILE PASSING VACUOUSLY. `page.viewport` is
 * asynchronous and resizes the tester iframe rather than the browser window; if
 * it silently did not take, every clamp assertion below would be graded against
 * the 896px DEFAULT, at which the clamp never fires and layer 4 could be deleted
 * with the file still green. So the value the component will read is asserted
 * directly, in the same units, before anything renders.
 */
async function setViewport([w, h]: [number, number]) {
  await page.viewport(w, h);
  expect(
    window.innerHeight,
    `page.viewport did not take: the component reads window.innerHeight, which is ` +
      `${window.innerHeight}, not the ${h} this test set`
  ).toBe(h);
}

/** Render at a viewport and hand the block ready. */
async function renderReady(
  viewport: [number, number],
  iframeOverrides: Record<string, unknown> = {}
) {
  await setViewport(viewport);
  const rendered = renderWithProviders(
    <IframeHost
      install={makeInstall(iframeOverrides)}
      context={context}
      token="tok_abc"
      expiresAt={new Date(Date.now() + 15 * 60_000).toISOString()}
    />
  );
  await driveToReady();
  // 🔴 THE GUARD THAT KEEPS EVERY PIXEL BELOW MEANINGFUL. Same predicate the
  // styled sibling uses: the chrome's `Group` only computes to `display: flex`
  // once `@mantine/core/styles.css` is in the cascade. Without it this suite
  // still passes — every assertion is self-relative — while measuring a chrome
  // of 98 and a frame border of 0, which is exactly how a wrong residue table
  // got published. If the import at the top of this file is ever dropped, this
  // fails instead of quietly going meaningless.
  expect(
    getComputedStyle(chromeEl()).display,
    '@mantine/core/styles.css is not loaded: the chrome computes to ' +
      `"${getComputedStyle(chromeEl()).display}" instead of "flex", so every pixel this suite ` +
      'measures is a property of the empty cascade rather than of the real component'
  ).toBe('flex');
  expect(
    appliedHeight(),
    'precondition: the iframe should start at the manifest minHeight, so a later pass ' +
      'cannot be "it was already there"'
  ).toBe(MIN_H);
  return rendered;
}

describe('IframeHost height layer 4 — the viewport clamp', () => {
  test('a 3000px self-report at a 640px viewport leaves the WHOLE FRAMED WIDGET inside the viewport', async () => {
    // 🔴 THE ASSERTION IS ON THE FRAME, NOT THE IFRAME, AND THAT IS THE POINT.
    // `framed()` renders AppBlockChrome ABOVE the iframe inside one bordered box,
    // so bounding the iframe at the viewport still yields a
    // `viewport + chrome + borders` widget. Measured before the fix at 390x640:
    // iframe 640 (correct), frame 673 (chrome 31 + 1px top + 1px bottom) — a
    // 673px widget on a 640px screen, which an iframe-only assertion passes
    // straight through.
    await renderReady(PHONE);

    postFromBlock('RESIZE_IFRAME', { height: REPORT });

    // 🔴 `toBe(PHONE_H)`, NOT `toBeLessThanOrEqual` — measured, the loose form is
    // satisfied by the PRE-UPDATE state (the minHeight reserve, 160 + 33 = 193
    // ≤ 640), so `vi.waitFor` returns before the resize has been applied and the
    // assertions after it grade the wrong frame. Requiring the widget to fill the
    // viewport exactly is both the real property and a condition the initial
    // state cannot meet.
    await vi.waitFor(() =>
      expect(
        frameHeight(),
        `layer 4 did not bound the WIDGET: the block asked for ${REPORT}px inside a ${PHONE_H}px ` +
          `viewport and the framed widget is ${frameHeight()}px (iframe ${appliedHeight()}px + ` +
          `chrome ${chromeHeight()}px + border ${frameBorderPx()}px). With no manifest ` +
          `maxHeight the only other bound is ` +
          `HARD_HEIGHT_CEILING (8000), which cannot produce ${PHONE_H}.`
      ).toBe(PHONE_H)
    );

    // The iframe therefore takes exactly the budget the overhead leaves. Both
    // halves are MEASURED here, never assumed: hardcoding the 33px observed
    // above is one theme or breakpoint away from wrong.
    expect(
      appliedHeight(),
      `the iframe should take exactly the viewport budget left by the chrome: viewport ` +
        `${PHONE_H} − chrome ${chromeHeight()} − border ${frameBorderPx()} = ${expectedBudget(
          PHONE_H
        )}, got ${appliedHeight()}`
    ).toBe(expectedBudget(PHONE_H));

    // Nothing below the widget is pushed off-screen.
    expect(
      document.documentElement.scrollHeight,
      `the document overflows the viewport by ` +
        `${document.documentElement.scrollHeight - PHONE_H}px`
    ).toBeLessThanOrEqual(PHONE_H);
  });

  test('a 400px self-report at a 640px viewport is honoured unchanged — the clamp is a ceiling, not a pin', async () => {
    // 🔴 The negative half, and it is not optional: without it a mutant that
    // replaces the clamp with `next = budget` outright satisfies the test above
    // and survives. 400 ≠ the budget, so this one sees it.
    await renderReady(PHONE);

    // Precondition, so this test cannot silently change meaning if the chrome
    // ever grows past 240px and the budget drops below SHORT.
    expect(
      expectedBudget(PHONE_H),
      `fixture precondition broken: the ${PHONE_H}px viewport leaves only ` +
        `${expectedBudget(PHONE_H)}px after ${chromeHeight()}px of chrome and ` +
        `${frameBorderPx()}px of border, which is not more ` +
        `than the ${SHORT}px this test reports — the clamp would legitimately fire and this ` +
        `case would stop testing what it says it does`
    ).toBeGreaterThan(SHORT);

    postFromBlock('RESIZE_IFRAME', { height: SHORT });

    await vi.waitFor(() =>
      expect(
        appliedHeight(),
        `layer 4 over-fired: a ${SHORT}px block already fits a ${PHONE_H}px viewport, so the ` +
          `host must apply ${SHORT}px and not ${appliedHeight()}px`
      ).toBe(SHORT)
    );
  });

  test('the manifest minHeight still wins on a viewport shorter than it', async () => {
    // `Math.max(min, budget)`, not a bare `budget`: a clamp that ignored the
    // floor would undo the manifest's own reserve and pin the slot at the
    // viewport (or, once the chrome is subtracted, below it).
    //
    // 🔴 This assertion has the shape of a reassuring ZERO — "the height did not
    // move off minHeight" — which a RESIZE_IFRAME that was never delivered would
    // also produce. What rules that out is the mutation control rather than
    // anything visible here: replacing `Math.max(min, budget)` with a bare
    // `budget` fails this test reporting the BUDGET, so the message did arrive
    // and did drive the clamp.
    await renderReady([320, 100]);

    postFromBlock('RESIZE_IFRAME', { height: REPORT });

    await new Promise((r) => setTimeout(r, 150));
    expect(
      appliedHeight(),
      `the manifest floor lost to the viewport: minHeight is ${MIN_H} and the viewport is 100, ` +
        `so the host must apply ${MIN_H}px and not ${appliedHeight()}px`
    ).toBe(MIN_H);
  });

  test('a manifest maxHeight tighter than the viewport still wins (layer 2 is not bypassed)', async () => {
    await renderReady(PHONE, { maxHeight: 300 });

    postFromBlock('RESIZE_IFRAME', { height: REPORT });

    await vi.waitFor(() =>
      expect(
        appliedHeight(),
        `layer 2 was bypassed: manifest maxHeight is 300 and the viewport is ${PHONE_H}, so the ` +
          `tighter of the two (300) must win, not ${appliedHeight()}px`
      ).toBe(300)
    );
  });
});

describe('IframeHost height layer 4 — re-clamp on viewport change', () => {
  test('a height negotiated at a phone viewport re-grows when the viewport does, then shrinks again', async () => {
    // 🔴 A clamp read ONCE, at handshake time, is not a bound — it is a snapshot.
    // The block is never asked to re-measure (RESIZE_IFRAME is one-way,
    // block → host), so the host has to keep the block's own STATED height and
    // re-apply the rules itself.
    //
    // 🔴 THE ORDER IS LOAD-BEARING: SHORT VIEWPORT FIRST. Written the other way
    // round (negotiate at 900, shrink to 640, grow back to 900) a mutant that
    // stashes the CLAMPED height instead of the reported one SURVIVES — measured,
    // the whole file stayed green — because the value it stashed at the tall
    // viewport (900) is numerically the same as the answer the last assertion
    // wants. Negotiating at 640 makes the stashed value 3000 vs 640, and those
    // two disagree at every later viewport.
    await renderReady(PHONE);

    postFromBlock('RESIZE_IFRAME', { height: REPORT });
    // Exact, for the reason spelled out in the first test: a `<=` wait is
    // satisfied by the pre-update minHeight reserve and would capture `atPhone`
    // below as the reserve rather than the clamped height.
    await vi.waitFor(() =>
      expect(frameHeight(), `the ${PHONE_H}px viewport did not bound a ${REPORT}px report`).toBe(
        PHONE_H
      )
    );
    const atPhone = appliedHeight();

    // Rotate to the tall viewport. Nothing is re-sent by the block, and the host
    // must re-derive from what the block STATED (3000), not from what it applied
    // — a host that re-clamped its own clamped value could only ever ratchet
    // downward and would stay at the phone-sized height here.
    await setViewport(TALL);
    await vi.waitFor(() =>
      expect(
        appliedHeight(),
        `the slot did not re-grow when the viewport did: the block stated ${REPORT}px, the ` +
          `viewport is now ${TALL_H}px, and the host still applies ${appliedHeight()}px (it was ` +
          `${atPhone}px at the ${PHONE_H}px viewport) — it is either not listening for viewport ` +
          `changes at all, or re-clamping its own clamped value rather than the block's stated ` +
          `height.`
      ).toBe(expectedBudget(TALL_H))
    );
    expect(
      frameHeight(),
      `the re-grown widget overflows the ${TALL_H}px viewport at ${frameHeight()}px`
    ).toBeLessThanOrEqual(TALL_H);

    // …and back down, so the bound is shown to track the viewport in both
    // directions rather than only ratcheting one way.
    await setViewport(PHONE);
    await vi.waitFor(() =>
      expect(
        appliedHeight(),
        `the slot did not shrink on a viewport change: the viewport is now ${PHONE_H}px and the ` +
          `host still applies ${appliedHeight()}px.`
      ).toBe(atPhone)
    );
  });

  test('shrinking the viewport BELOW the manifest floor falls back to the floor, not through it', async () => {
    // 🔴 WITHOUT THIS CASE THE RE-CLAMP'S `min` ARGUMENT IS UNTESTED. Measured: a
    // mutant hardcoding the source's own default (`clampBlockHeight(reported,
    // 200, …)`) in the re-clamp call site SURVIVED the rest of this file — every
    // other re-clamp case runs at a viewport where the BUDGET wins, so which
    // number is passed as the floor never shows. Only a viewport small enough for
    // the floor to win can see it, and only because MIN_H is not 200.
    await renderReady(PHONE);

    postFromBlock('RESIZE_IFRAME', { height: REPORT });
    await vi.waitFor(() =>
      expect(
        frameHeight(),
        `setup for the floor case: the widget should first settle at the ${PHONE_H}px viewport ` +
          `before it is shrunk, and it is ${frameHeight()}px`
      ).toBe(PHONE_H)
    );

    await setViewport([320, 100]);

    await vi.waitFor(() =>
      expect(
        appliedHeight(),
        `the re-clamp used the wrong floor: the manifest declares minHeight ${MIN_H} and the ` +
          `viewport (100px) leaves less than that, so the host must fall back to ${MIN_H}px and ` +
          `not ${appliedHeight()}px`
      ).toBe(MIN_H)
    );
  });

  /**
   * 🔴 AN INVARIANT GUARD, NOT REGRESSION COVERAGE — labelled so nobody counts it
   * as the latter. The line it corresponds to (`if (reported === null) return;`)
   * is a TYPE NARROWING and is behaviourally inert on every reachable input:
   * pre-handshake the height state is already `min`, and clamping anything
   * against `Math.max(min, budget)` at that moment returns `min` too, so
   * neutering the early-out changes nothing observable. Deleting the line is not
   * possible without a `??` because the ref is `number | null`.
   *
   * What this case genuinely pins is that equivalence: a viewport change before
   * the handshake must not move the slot off its reserve. If someone later makes
   * the pre-handshake path do real work, this goes red.
   */
  test('INVARIANT: a viewport change before the block has stated any height leaves the slot at minHeight', async () => {
    await renderReady(TALL);

    await setViewport(PHONE);

    await new Promise((r) => setTimeout(r, 150));
    expect(
      appliedHeight(),
      `a viewport change moved the slot before the block stated any height: expected the ` +
        `${MIN_H}px minHeight reserve, got ${appliedHeight()}px`
    ).toBe(MIN_H);
  });

  /**
   * 🔴 THE CLEANUP HAS NO OBSERVABLE OF ITS OWN, SO PIN THE RELATIONSHIP. Deleting
   * the effect's `removeEventListener` return survives every behavioural test in
   * this file — React does not warn on a setState from an unmounted component, so
   * a leaked `resize` listener is completely silent. The honest guard is a ledger:
   * capture the identity of every `resize` handler the component ADDS and every
   * one it REMOVES, then require the two sets to match after unmount. That fails
   * if the cleanup is dropped, if it removes a different function than it added,
   * and if a future second listener is added without a matching removal.
   */
  test('the resize listener is removed on unmount — no leaked handler', async () => {
    const added = new Set<EventListenerOrEventListenerObject>();
    const removed = new Set<EventListenerOrEventListenerObject>();
    // 🔴 A DIRECT PATCH, NOT `vi.spyOn(...).mockImplementation(...)`. Both
    // `addEventListener` and `removeEventListener` are OVERLOADED, and
    // `mockImplementation` wants one concrete signature — every spelling of the
    // parameters is rejected by `pnpm typecheck` (TS2345, then TS2769) while
    // running green locally, which is the worst combination. Patching the two
    // methods behind a single cast each is honest about where the unavoidable
    // unsoundness is, and both are restored in `finally`.
    const origAdd = window.addEventListener;
    const origRemove = window.removeEventListener;
    window.addEventListener = ((
      type: string,
      fn: EventListenerOrEventListenerObject,
      opts?: boolean | AddEventListenerOptions
    ) => {
      if (type === 'resize' && fn) added.add(fn);
      origAdd.call(window, type, fn, opts);
    }) as typeof window.addEventListener;
    window.removeEventListener = ((
      type: string,
      fn: EventListenerOrEventListenerObject,
      opts?: boolean | EventListenerOptions
    ) => {
      if (type === 'resize' && fn) removed.add(fn);
      origRemove.call(window, type, fn, opts);
    }) as typeof window.removeEventListener;

    try {
      const rendered = await renderReady(PHONE);
      postFromBlock('RESIZE_IFRAME', { height: REPORT });
      await vi.waitFor(() => expect(appliedHeight()).not.toBe(MIN_H));

      // POSITIVE CONTROL for the ledger itself: a zero-vs-zero comparison would
      // pass with the spies wired to nothing at all.
      expect(
        added.size,
        'the ledger observed no `resize` listener being added at all, so the emptiness of the ' +
          'leak set below would prove nothing about the cleanup'
      ).toBeGreaterThan(0);

      await rendered.unmount();

      const leaked = [...added].filter((fn) => !removed.has(fn));
      expect(
        leaked.length,
        `${leaked.length} of ${added.size} \`resize\` listener(s) added by the host outlived its ` +
          `unmount. The effect's cleanup either does not run, or removes a different function ` +
          `than it added.`
      ).toBe(0);
    } finally {
      window.addEventListener = origAdd;
      window.removeEventListener = origRemove;
    }
  });
});
