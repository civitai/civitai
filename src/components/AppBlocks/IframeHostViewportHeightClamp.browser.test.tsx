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
 * phone viewport — the slot swallowed the page. Layer 4 bounds the iframe to
 * `Math.max(minHeight, viewportHeight)`; the block scrolls internally instead,
 * which is the intended outcome.
 *
 * 🔴 THE HARNESS WILL MAKE THIS FILE PASS VACUOUSLY IF YOU LET IT. Vitest's
 * browser default viewport is 414x896 (measured: `resolved.browser.viewport
 * .height ??= 896` in vitest's config resolution), and `test/component-setup
 * .tsx` sets none. At 896px tall, every height any neighbouring IframeHost suite
 * asserts (640, 700, 800) is already UNDER the bound, so the clamp never fires
 * and a test written without `page.viewport(...)` cannot tell layer 4 from its
 * absence. Every test here calls `page.viewport(...)` FIRST, and
 * `assertViewportHeight` re-reads `window.innerHeight` afterwards so a
 * `page.viewport` that silently did not take is a failure rather than a green.
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
 * constant the assertions name, so no assertion can be satisfied by a collision:
 *
 *   PHONE_H  640  — the bound under test.
 *   TALL_H   900  — a second viewport, for the re-clamp on resize.
 *   REPORT   3000 — what the block claims. Well OVER 640 (so the clamp is
 *                   demonstrably what acts) and well UNDER HARD_HEIGHT_CEILING
 *                   (8000), so layer 3 cannot be what produces a pass.
 *   SHORT    400  — under both viewports, so the clamp must NOT fire.
 *   MIN_H    200  — the manifest floor.
 * `maxHeight` is ABSENT: that omission is the gap this file exists for.
 */
const PHONE: [number, number] = [390, 640];
const PHONE_H = 640;
const TALL: [number, number] = [390, 900];
const TALL_H = 900;
const REPORT = 3000;
const SHORT = 400;
const MIN_H = 200;

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

/** The height the host has actually written onto the iframe element. */
function appliedHeight(): number {
  return Number.parseFloat(iframeEl().style.height);
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

/** Render at a viewport, hand the block ready, and return the applied height. */
async function renderReady(
  viewport: [number, number],
  iframeOverrides: Record<string, unknown> = {}
) {
  await setViewport(viewport);
  renderWithProviders(
    <IframeHost
      install={makeInstall(iframeOverrides)}
      context={context}
      token="tok_abc"
      expiresAt={new Date(Date.now() + 15 * 60_000).toISOString()}
    />
  );
  await driveToReady();
  expect(
    appliedHeight(),
    'precondition: the iframe should start at the manifest minHeight, so a later pass ' +
      'cannot be "it was already there"'
  ).toBe(MIN_H);
}

describe('IframeHost height layer 4 — the viewport clamp', () => {
  test('a 3000px self-report at a 640px viewport is clamped to the viewport, not honoured', async () => {
    await renderReady(PHONE);

    postFromBlock('RESIZE_IFRAME', { height: REPORT });

    await vi.waitFor(() =>
      expect(
        appliedHeight(),
        `layer 4 did not bound the slot: the block asked for ${REPORT}px inside a ${PHONE_H}px ` +
          `viewport and the host applied ${appliedHeight()}px. With no manifest maxHeight the ` +
          `only other bound is HARD_HEIGHT_CEILING (8000), which cannot produce ${PHONE_H}.`
      ).toBe(PHONE_H)
    );
  });

  test('a 400px self-report at a 640px viewport is honoured unchanged — the clamp is a ceiling, not a pin', async () => {
    // 🔴 The negative half, and it is not optional: without it a mutant that
    // replaces the clamp with `next = viewportHeight` outright satisfies the test
    // above and survives. 400 ≠ 640, so this one sees it.
    await renderReady(PHONE);

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
    // `Math.max(min, viewport)`, not a bare `viewport`: a clamp that ignored the
    // floor would undo the manifest's own reserve and pin the slot at 100px.
    //
    // 🔴 This assertion has the shape of a reassuring ZERO — "the height did not
    // move off minHeight" — which a RESIZE_IFRAME that was never delivered would
    // also produce. What rules that out is the mutation control rather than
    // anything visible here: replacing `Math.max(min, viewport)` with a bare
    // `viewport` fails this test with `not 100px`, i.e. the message reports the
    // VIEWPORT height, so the message did arrive and did drive the clamp.
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
    await vi.waitFor(() =>
      expect(appliedHeight(), `the ${PHONE_H}px viewport did not bound a ${REPORT}px report`).toBe(
        PHONE_H
      )
    );

    // Rotate to the tall viewport. Nothing is re-sent by the block, and the host
    // must re-derive from what the block STATED (3000), not from what it applied
    // (640) — a host that re-clamped its own clamped value could only ever
    // ratchet downward and would stay at 640 here.
    await setViewport(TALL);
    await vi.waitFor(() =>
      expect(
        appliedHeight(),
        `the slot did not re-grow when the viewport did: the block stated ${REPORT}px and the ` +
          `viewport is now ${TALL_H}px, so the host must apply ${TALL_H}px and not ` +
          `${appliedHeight()}px — it is either not listening for viewport changes at all, or ` +
          `re-clamping its own clamped value rather than the block's stated height.`
      ).toBe(TALL_H)
    );

    // …and back down, so the bound is shown to track the viewport in both
    // directions rather than only ratcheting one way.
    await setViewport(PHONE);
    await vi.waitFor(() =>
      expect(
        appliedHeight(),
        `the slot did not shrink on a viewport change: it was ${TALL_H}px, the viewport is now ` +
          `${PHONE_H}px, and the host still applies ${appliedHeight()}px.`
      ).toBe(PHONE_H)
    );
  });

  test('a viewport change before the block has stated any height leaves the slot at minHeight', async () => {
    // The resize listener is registered at mount, so it runs while the block is
    // still pre-handshake. It must be a no-op then rather than writing a height
    // the block never asked for.
    await renderReady(TALL);

    await setViewport(PHONE);

    await new Promise((r) => setTimeout(r, 150));
    expect(
      appliedHeight(),
      `a viewport change moved the slot before the block stated any height: expected the ` +
        `${MIN_H}px minHeight reserve, got ${appliedHeight()}px`
    ).toBe(MIN_H);
  });
});
