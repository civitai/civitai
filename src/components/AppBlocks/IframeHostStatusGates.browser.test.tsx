import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { useDialogStore } from '~/components/Dialog/dialogStore';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { onReadyAttributeWrite } from '../../../test/commitWindow';
// Type-only namespace import for the `importActual` generic below.
// `@typescript-eslint/consistent-type-imports` rejects an inline
// `typeof import('...')` annotation, so the type has to arrive this way.
import type * as AuthHelpers from '~/utils/auth-helpers';
import type * as Trpc from '~/utils/trpc';

/**
 * IframeHost's STATUS-GATED message handlers — the model-slot twin of the
 * PageBlockHost defect fixed in #3680.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────────
 *
 * Four IframeHost handlers gate on the host being ready: RESIZE_IFRAME,
 * REQUEST_SIGN_IN, REQUEST_CONSENT and OPEN_BUZZ_PURCHASE. Each closed over
 * `status` from the render that registered it, with `status` in its effect's
 * dependency array — so the LIVE listener only picks up a new status when React
 * flushes that effect. React writes `data-block-ready` during the COMMIT and
 * flushes passive effects in a LATER scheduler task, so there is a window in which
 * the host publicly reports ready while the live handler still holds
 * `status === 'loading'` and drops the message.
 *
 * ── WHY A SEPARATE FILE ─────────────────────────────────────────────────────────
 *
 * IframeHost.browser.test.tsx is the beacon/GET_BUZZ_BALANCE suite. These guards
 * need two things it does not have — a mocked `openLoginPopup` and the dialogStore
 * — and they mirror PageBlockHostWorkflow/PageBlockHostSignIn rather than that
 * file, so they live beside it instead of inside it.
 *
 * ── WHAT THESE GUARDS CANNOT PROVE ──────────────────────────────────────────────
 *
 * That a real deployed block hits the window. As #3680 said of the page host: no
 * SDK code path auto-posts a gated request on ready — all of them are `useCallback`s
 * the app invokes — so reaching the window needs app code that calls one in the same
 * turn it observes ready, and no such block was observed. This is a latent defect
 * being closed, not a reported outage.
 */

// Per-test-controllable mutation impls. `vi.mock` is hoisted, so the fns must live
// in a hoisted block the factory can close over.
const mocks = vi.hoisted(() => ({
  balance: vi.fn(),
}));

// AppBlockChrome (in the host frame) calls useCurrentUser() for the platform-nav
// moderator gate; these suites render the real host without a CivitaiSessionProvider.
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

// IframeHost reads `appBlocks && appBlocksPages` (the run route's own predicate) to
// decide whether the chrome may offer `/apps/run/<blockId>` shortcuts; the real hook
// THROWS without a FeatureFlagsProvider (which this scaffold does not mount). Dark
// flags = the production default, and these suites assert host gating, not the menu.
// Deliberately a WHOLE-module factory, not an `importOriginal` spread — see the note
// in IframeHost.browser.test.tsx.
// 🔴 `useOptionalFeatureFlags` IS LISTED TOO, AND OMITTING IT BREAKS THE WHOLE FILE.
// This factory REPLACES the module (deliberately — see the note above), so it must
// name every export anything in this file's module graph imports. The app-block
// chrome's breadcrumb crumb reads `useOptionalFeatureFlags` for its store gate (the
// non-throwing variant, because the chrome renders outside a provider), and the day
// it started doing so this factory stopped satisfying the link:
//   SyntaxError: The requested module '/src/providers/FeatureFlagsProvider.tsx'
//   does not provide an export named 'useOptionalFeatureFlags'
//
// 🔴 THE FILE THEN FAILS TO IMPORT, WHICH IS NOT THE SAME AS FAILING. Nothing is
// collected, so the run reported `Test Files 6 failed` alongside `Tests 374 passed`
// — zero failing ASSERTIONS. Anything reading a failure count, or a per-test
// summary, sees success. Read the FILE count, not the test count.
//
// Both hooks return the SAME flags: the gate must be decided by this fixture, not
// by which of the two a component happens to call.
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: false, appBlocksPages: false }),
  useOptionalFeatureFlags: () => ({ appBlocks: false, appBlocksPages: false }),
}));

// IframeHost drives two tRPC queries at render (getEffectiveCheckpoint +
// getShowcaseImages) and wires the workflow/storage bridges. None of that is under
// test here, so stub it all so the component mounts network-free and the init
// handshake is ALLOWED to start immediately (getEffectiveCheckpoint must report
// `isLoading: false` so `shouldStartInit` fires).
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
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
      getMyBuzzBalance: { useMutation: () => ({ mutateAsync: mocks.balance }) },
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

// useBrowsingLevelDebounced reads a context the network-free scaffold doesn't
// provide; the value only feeds the (mocked) showcase query, so stub a constant.
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', () => ({
  useBrowsingLevelDebounced: () => 1,
}));

// Login is hub-driven (a popup to auth.civitai.com via openLoginPopup). Stub it so
// the REQUEST_SIGN_IN guard can assert the call without opening a window.
// IframeHost.browser.test.tsx does NOT mock this module — the sign-in gate is not
// exercised there — which is one of the two reasons these guards live in their own
// file.
vi.mock('~/utils/auth-helpers', async (importActual) => ({
  ...(await importActual<typeof AuthHelpers>()),
  openLoginPopup: vi.fn(),
}));

// eslint-disable-next-line import/first
import { IframeHost } from '~/components/AppBlocks/IframeHost';
// eslint-disable-next-line import/first
import type { BlockInstall, ModelSlotContext } from '~/components/AppBlocks/types';
// eslint-disable-next-line import/first
import { openLoginPopup } from '~/utils/auth-helpers';

// Same-origin so trustTier='internal' yields a pinned (non-opaque) transport whose
// expectedOrigin equals this frame's origin.
const SAME_ORIGIN_SRC = `${window.location.origin}/`;

// Simulate a message FROM the block by dispatching a MessageEvent whose `source` is
// the iframe's contentWindow and whose `origin` matches the host's expectedOrigin.
// This satisfies BOTH authenticating pins usePostMessage enforces.
function postFromBlock(type: string, payload?: unknown) {
  const iframeEl = page.getByTestId('block-iframe').element() as HTMLIFrameElement;
  const cw = iframeEl.contentWindow;
  if (!cw) throw new Error('iframe contentWindow missing');
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type, payload },
      origin: window.location.origin,
      source: cw,
    })
  );
}

// Capture host→block replies. `send` posts onto the iframe's contentWindow, so we
// listen there.
function listenForReply() {
  const received: Array<{ type: string; payload: unknown }> = [];
  const iframeEl = page.getByTestId('block-iframe').element() as HTMLIFrameElement;
  const cw = iframeEl.contentWindow;
  if (!cw) throw new Error('iframe contentWindow missing');
  const handler = (e: MessageEvent) => {
    const d = e.data as { type?: string; payload?: unknown } | null;
    if (d && typeof d.type === 'string') received.push({ type: d.type, payload: d.payload });
  };
  cw.addEventListener('message', handler);
  return {
    received,
    last: (type: string) => [...received].reverse().find((m) => m.type === type),
    stop: () => cw.removeEventListener('message', handler),
  };
}

const install: BlockInstall = {
  blockInstanceId: 'mbi_test',
  blockId: 'my-model-app',
  appId: 'app_test',
  appBlockId: 'apb_test',
  manifest: {
    name: 'Background Remover',
    scopes: ['ai:write:budgeted'],
    iframe: {
      src: SAME_ORIGIN_SRC,
      minHeight: 200,
      maxHeight: 800,
      resizable: true,
      sandbox: 'allow-scripts',
    },
  },
  publisherSettings: {},
  enabled: true,
  renderMode: 'iframe',
  trustTier: 'internal',
};

// model.sidebar_top is the live production slot.
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

const baseProps = {
  install,
  context,
  token: 'tok_abc',
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
};

// REQUEST_CONSENT is a TWO-condition gate (requestConsentGate.ts): status must be
// 'ready' AND `missingScopes` must be non-empty. With the default `baseProps` the
// second condition alone drops every request, so a consent guard mounted on them
// would pass for a reason that has nothing to do with the status gate — the shape
// of a vacuous test. These props satisfy the scopes half so the STATUS half is the
// only thing under test.
const consentProps = { ...baseProps, missingScopes: ['ai:write:budgeted'] };

// The manifest's minHeight, i.e. the height the iframe is pinned at from mount
// until something honours a RESIZE_IFRAME. Any assertion that "the height did not
// move" is an assertion that it is still this.
const MIN_HEIGHT = 200;
// A distinct in-bounds height (manifest min 200 / max 800), so a pass cannot be
// the clamp landing on the default by coincidence.
const RESIZE_HEIGHT = 640;

// The host renders the negotiated height as an inline style on the iframe.
function iframeHeightPx(): number {
  const el = page.getByTestId('block-iframe').element() as HTMLIFrameElement;
  return parseFloat(el.style.height);
}

async function waitForMount() {
  await vi.waitFor(() => {
    const el = page.getByTestId('block-iframe').element() as HTMLIFrameElement;
    if (!el.contentWindow) throw new Error('not mounted yet');
  });
}

// Drive the handshake to BLOCK_READY (status='ready') — the transition a real block
// hits once it acks the host's BLOCK_INIT.
async function driveToReady() {
  await waitForMount();
  await vi.waitFor(() => {
    postFromBlock('BLOCK_READY', {});
    const el = page.getByTestId('block-iframe').element() as HTMLIFrameElement;
    if (el.getAttribute('data-block-ready') !== 'true') throw new Error('not ready yet');
  });
}

/**
 * Wait for the iframe to mount, then post BLOCK_READY on a CANCELLABLE interval.
 *
 * Cancellable is load-bearing: a drive left running past the end of a test posts
 * BLOCK_READY into the NEXT test's freshly-mounted host — measured on the page host,
 * that turned a "before BLOCK_READY is dropped" guard red for a reason having nothing
 * to do with the race under study. Callers stop it in a `finally`.
 *
 * Unlike `driveToReady` this returns control to the caller WITHOUT waiting for
 * `data-block-ready` — the point is that the `onReadyAttributeWrite` hook fires from
 * inside React's commit, on React's own stack, while this drive is still running.
 *
 * 🔴 THE INTERVAL IS BOUNDED BY usePostMessage'S OWN RATE LIMIT, not by taste. That
 * transport drops inbound messages once RATE_LIMIT_MAX_MESSAGES = 30 have arrived
 * within RATE_LIMIT_WINDOW_MS = 1000 (usePostMessage.ts), counting only types that
 * have a subscriber — which BLOCK_READY does. At the original 10ms this drive asked
 * for 100/s against a 30/s budget, so a drive that ran for a full second would spend
 * ~70% of it above the limit, dropping its own posts (and the one the commit-window
 * hook piggybacks) with a `console.warn` each. It worked because the drives are
 * short and the decisive post lands in the first few ticks — i.e. it was under the
 * limit by luck of timing, not by construction, and every guard added here narrows
 * that margin. 40ms is 25/s, which stays under the budget with headroom for the
 * commit-window post on top. Raise this number, never lower it.
 *
 * (Stated as the arithmetic it is: the constants are read from usePostMessage.ts,
 * the drop count itself was not instrumented.)
 */
const READY_DRIVE_INTERVAL_MS = 40;

async function startReadyDrive() {
  await waitForMount();
  const timer = setInterval(() => postFromBlock('BLOCK_READY', {}), READY_DRIVE_INTERVAL_MS);
  postFromBlock('BLOCK_READY', {});
  return () => clearInterval(timer);
}

describe('IframeHost status gates — commit→passive-effect window (model.sidebar_top)', () => {
  beforeEach(() => {
    // dialogStore is a module-level zustand store shared across tests — reset it
    // (the OPEN_BUZZ_PURCHASE handler triggers a dialog on it).
    useDialogStore.getState().closeAll();
    vi.mocked(openLoginPopup).mockClear();
    mocks.balance.mockReset();
  });

  /**
   * GUARD 1 — the commit-gap positive, on the money gate.
   *
   * OPEN_BUZZ_PURCHASE is request/response: the block awaits BUZZ_PURCHASE_RESULT on
   * a promise that rejects only at the SDK's 30s default request timeout
   * (`DEFAULT_REQUEST_TIMEOUT_MS`, @civitai/blocks-react 0.39.0) — so a drop here
   * costs the user's click plus half a minute of nothing.
   *
   * 🔴 The post is driven from `onReadyAttributeWrite`, NOT a MutationObserver — see
   * test/commitWindow.tsx. A MutationObserver callback is a microtask that runs at the
   * END of the scheduler task, often after React has already flushed the passive
   * effects, which made the first version of the page host's guard survive its mutant
   * about one run in three.
   *
   * Proven reachable by mutation: move `statusRef.current = status` out of the render
   * body and back into an effect and this goes red on `expected [] to have a length
   * of 1`.
   */
  test("OPEN_BUZZ_PURCHASE posted in React's commit→passive-effect gap still opens the modal", async () => {
    renderWithProviders(<IframeHost {...baseProps} />);
    const unpatch = onReadyAttributeWrite(() =>
      postFromBlock('OPEN_BUZZ_PURCHASE', { requestId: 'rq_gap', suggestedAmount: 1000 })
    );
    try {
      const stopDrive = await startReadyDrive();
      try {
        await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));
      } finally {
        stopDrive();
      }
    } finally {
      unpatch();
    }
    // Pin the per-request dialog id, so this proves THIS post opened the modal.
    expect(useDialogStore.getState().dialogs[0].id).toBe('block-buy-buzz-rq_gap');
  });

  /**
   * GUARD 2 — the refusal is now SPOKEN instead of silent.
   *
   * The gate's REFUSAL is unchanged — no pre-handshake spend modal, ever. What
   * changed is that this branch used to drop the message with a bare `return`,
   * leaving the block's promise to hang for the SDK's full 30s request timeout.
   *
   * `purchased: false` is the same shape the modal's own onClose sends for a
   * dismissed purchase, and the same shape `useBuzzPurchase` reads as "no purchase
   * happened". Nothing is charged.
   *
   * Proven reachable by mutation: delete the NACK `send` and this goes red on
   * `no NACK yet`.
   */
  test('OPEN_BUZZ_PURCHASE before BLOCK_READY opens no modal and NACKs (never hangs)', async () => {
    renderWithProviders(<IframeHost {...baseProps} />);
    // Do NOT drive to ready — fire while status is still 'loading'.
    await waitForMount();
    const replies = listenForReply();

    postFromBlock('OPEN_BUZZ_PURCHASE', { requestId: 'rq_buzz_early', suggestedAmount: 1000 });

    await vi.waitFor(() => {
      const r = replies.last('BUZZ_PURCHASE_RESULT');
      if (!r) throw new Error('no NACK yet');
    });
    // THE security property, unchanged: the spend modal never opened.
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    // THE new property: the block was told, on its own requestId, so it fails fast.
    expect(replies.last('BUZZ_PURCHASE_RESULT')!.payload).toEqual({
      requestId: 'rq_buzz_early',
      purchased: false,
    });
    replies.stop();
  });

  /**
   * GUARD 3 — the OTHER reason `resolveBuzzPurchaseRequest` returns null: a malformed
   * payload with no string requestId. That one is legitimately UNREPLIABLE — there is
   * no id to thread a reply back on — so it must still be dropped in total silence,
   * and the NACK above must not have widened into "reply to everything".
   *
   * POSITIVE CONTROL is load-bearing here: this asserts a ZERO (no modal, no extra
   * reply), and a host whose listener was never live produces that same zero. The
   * control proves the handler is live AND that a BUZZ_PURCHASE_RESULT is observable
   * at all before the zero is read, so the zero is a measurement rather than an
   * artefact.
   *
   * 🔴 COUNT ONLY `BUZZ_PURCHASE_RESULT`, never `received.length`. The host pushes
   * unrelated messages of its own (BLOCK_INIT, TOKEN_REFRESH, THEME_CHANGE) from
   * effects, on a schedule this test does not control — so a TOTAL message count
   * drifts for reasons that have nothing to do with the assertion. Measured on the
   * page host: an earlier draft counting `received.length` failed on
   * `expected 1 to be +0` against a host that was behaving perfectly.
   */
  test('OPEN_BUZZ_PURCHASE with NO requestId is dropped silently (nothing to reply to)', async () => {
    renderWithProviders(<IframeHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();
    const buzzReplies = () => replies.received.filter((m) => m.type === 'BUZZ_PURCHASE_RESULT');

    // POSITIVE CONTROL: a well-formed request DOES get through and open the modal,
    // and closing it DOES produce an observable BUZZ_PURCHASE_RESULT.
    postFromBlock('OPEN_BUZZ_PURCHASE', { requestId: 'rq_control', suggestedAmount: 10 });
    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));
    useDialogStore.getState().dialogs[0].options?.onClose?.();
    await vi.waitFor(() => expect(buzzReplies()).toHaveLength(1));
    useDialogStore.getState().closeAll();

    // The real case: no requestId at all.
    postFromBlock('OPEN_BUZZ_PURCHASE', { suggestedAmount: 1000 });

    await new Promise((r) => setTimeout(r, 150));
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    // Still exactly the control's reply — the malformed post added none.
    expect(buzzReplies()).toHaveLength(1);
    replies.stop();
  });

  /**
   * GUARD 4 — the ROOT-CAUSE half, on a gate with NO NACK to fall back on.
   *
   * REQUEST_SIGN_IN is fire-and-forget — it carries no requestId and has no reply
   * message — so a post dropped in this window is gone for good and the anonymous
   * viewer's click on "Sign in" does nothing at all, silently. There is no NACK
   * available to soften it, which is exactly why the root-cause fix (reading a
   * render-body-updated `statusRef` instead of a closed-over `status`) has to hold
   * for this handler. Guard 2's NACK cannot mask a regression here.
   *
   * Proven reachable by mutation: revert this handler to the closed-over `status`
   * (with `status` back in its deps) and this goes red on `expected
   * "openLoginPopup" to be called 1 times, but got 0 times`.
   */
  test("REQUEST_SIGN_IN posted in React's commit→passive-effect gap still starts the login", async () => {
    renderWithProviders(<IframeHost {...baseProps} />);
    // Fires synchronously on React's own stack, at the instant the host writes
    // data-block-ready="true" — strictly before this commit's passive effects
    // re-register a listener holding the fresh status.
    const unpatch = onReadyAttributeWrite(() => postFromBlock('REQUEST_SIGN_IN', {}));
    try {
      const stopDrive = await startReadyDrive();
      try {
        await vi.waitFor(() => {
          expect(openLoginPopup).toHaveBeenCalledTimes(1);
        });
      } finally {
        stopDrive();
      }
    } finally {
      unpatch();
    }
  });

  /**
   * The gate's own refusal, unchanged: a pre-handshake block cannot pop the login
   * popup. This is the negative half of guard 4 — without it, "the handler is live"
   * and "the handler always fires" are indistinguishable.
   */
  test('REQUEST_SIGN_IN before BLOCK_READY is dropped (no pre-handshake login popup)', async () => {
    renderWithProviders(<IframeHost {...baseProps} />);
    // Do NOT drive to ready — fire while status is still 'loading'.
    await waitForMount();

    postFromBlock('REQUEST_SIGN_IN', {});

    await new Promise((r) => setTimeout(r, 150));
    expect(openLoginPopup).not.toHaveBeenCalled();
  });

  /**
   * GUARD 6 — RESIZE_IFRAME, the third of the four gated handlers.
   *
   * 🔴 WHY THIS EXISTS: MEASURED, TWICE. Before this guard, reverting the
   * RESIZE_IFRAME handler to its exact pre-#3726 form — closing over `status`, with
   * `status` back in the effect's dependency array — left the ENTIRE
   * src/components/AppBlocks component suite green at 380 passed / 33 files. A
   * quarter of this fix could be silently undone. Guards 1 and 4 cover the money and
   * sign-in gates; nothing covered this one.
   *
   * Like REQUEST_SIGN_IN this handler is fire-and-forget with no NACK to soften a
   * drop, so the root-cause half (reading a render-body-updated `statusRef` rather
   * than a closed-over `status`) is the only thing standing between a block that
   * negotiates its height at ready and a slot stuck at minHeight.
   *
   * The observable is the iframe's inline height rather than a mock call count: it
   * is the actual user-visible effect, and it distinguishes "handler ran" from
   * "handler ran and the clamp let the value through".
   */
  test("RESIZE_IFRAME posted in React's commit→passive-effect gap is still honoured", async () => {
    renderWithProviders(<IframeHost {...baseProps} />);
    await waitForMount();
    // The height the assertion below must move OFF. Read before the drive so a
    // pass cannot be the iframe having already been at RESIZE_HEIGHT.
    expect(iframeHeightPx()).toBe(MIN_HEIGHT);

    const unpatch = onReadyAttributeWrite(() =>
      postFromBlock('RESIZE_IFRAME', { height: RESIZE_HEIGHT })
    );
    try {
      const stopDrive = await startReadyDrive();
      try {
        await vi.waitFor(() => expect(iframeHeightPx()).toBe(RESIZE_HEIGHT));
      } finally {
        stopDrive();
      }
    } finally {
      unpatch();
    }
  });

  /**
   * GUARD 7 — RESIZE_IFRAME's own refusal, which was ALSO unguarded.
   *
   * 🔴 This closes a WIDER gap than the commit-window one, and the PR that
   * introduced the fix did not disclose it: before this test, DELETING the
   * `readGateStatus() !== 'ready'` line outright also left the whole suite green. A
   * pre-handshake block could drive the slot's height around — while the iframe is
   * still pointerEvents:none and the user has interacted with nothing — and nothing
   * anywhere went red.
   *
   * 🔴 POSITIVE CONTROL is not optional. The first assertion is a ZERO ("the height
   * did not move"), and a harness that never delivered the message, or that reads an
   * `el.style.height` the host does not actually write, produces that same zero. The
   * control fires the SAME message on the SAME host after ready and requires the
   * height to move, so the zero above it is a measurement rather than an artefact.
   */
  test('RESIZE_IFRAME before BLOCK_READY does not move the slot height', async () => {
    renderWithProviders(<IframeHost {...baseProps} />);
    // Do NOT drive to ready — fire while status is still 'loading'.
    await waitForMount();
    expect(iframeHeightPx()).toBe(MIN_HEIGHT);

    postFromBlock('RESIZE_IFRAME', { height: RESIZE_HEIGHT });

    await new Promise((r) => setTimeout(r, 150));
    // THE security property: a pre-handshake block cannot resize the slot.
    expect(iframeHeightPx()).toBe(MIN_HEIGHT);

    // POSITIVE CONTROL: the identical message, once ready, IS honoured — so the
    // refusal above is the gate refusing, not the probe failing to observe.
    await driveToReady();
    postFromBlock('RESIZE_IFRAME', { height: RESIZE_HEIGHT });
    await vi.waitFor(() => expect(iframeHeightPx()).toBe(RESIZE_HEIGHT));
  });

  /**
   * GUARD 8 — REQUEST_CONSENT, the fourth gated handler and the one with the LEAST
   * coverage of any of them.
   *
   * 🔴 MEASURED: reverting this handler to the closed-over `status` (with `status`
   * back in its deps) left the whole suite green, exactly as for RESIZE_IFRAME. And
   * REQUEST_CONSENT had ZERO browser coverage against IframeHost anywhere in the
   * tree before this file — the three other files naming the message target
   * PageBlockHost or BlockConsentModal, neither of which exercises this handler.
   *
   * Fire-and-forget in both directions (no requestId, no host→block reply), so a
   * drop in the commit window is simply an anonymous-of-a-capability user clicking
   * "Generate" and getting nothing — no permission modal, no error, no retry.
   *
   * The assertion pins the modal's OWN props (`missingScopes`), not just
   * `dialogs.length`: the store is shared and a length check would be satisfied by
   * any dialog from any source.
   */
  test("REQUEST_CONSENT posted in React's commit→passive-effect gap still opens the consent modal", async () => {
    renderWithProviders(<IframeHost {...consentProps} />);
    const unpatch = onReadyAttributeWrite(() => postFromBlock('REQUEST_CONSENT', {}));
    try {
      const stopDrive = await startReadyDrive();
      try {
        await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));
      } finally {
        stopDrive();
      }
    } finally {
      unpatch();
    }
    // Prove it is the CONSENT modal, carrying the server-known missing set — not
    // some other dialog that happened to be open.
    expect(
      (useDialogStore.getState().dialogs[0].props as { missingScopes?: string[] }).missingScopes
    ).toEqual(['ai:write:budgeted']);
  });

  /**
   * GUARD 9 — REQUEST_CONSENT's refusal, the second undisclosed hole.
   *
   * 🔴 Deleting this handler's status gate (forcing `resolveRequestConsent` to see
   * 'ready') also left the whole suite green before this test: a pre-handshake block
   * could pop the PERMISSION modal — the one that grants it `ai:write:budgeted` —
   * before the user has interacted with anything.
   *
   * POSITIVE CONTROL as in guard 7, and for the same reason: "no modal opened" is
   * the observable a dead harness also produces.
   */
  test('REQUEST_CONSENT before BLOCK_READY opens no consent modal', async () => {
    renderWithProviders(<IframeHost {...consentProps} />);
    // Do NOT drive to ready — fire while status is still 'loading'.
    await waitForMount();

    postFromBlock('REQUEST_CONSENT', {});

    await new Promise((r) => setTimeout(r, 150));
    // THE security property: no pre-handshake permission prompt.
    expect(useDialogStore.getState().dialogs).toHaveLength(0);

    // POSITIVE CONTROL: the identical message, once ready, DOES open it.
    await driveToReady();
    postFromBlock('REQUEST_CONSENT', {});
    await vi.waitFor(() => expect(useDialogStore.getState().dialogs).toHaveLength(1));
    expect(
      (useDialogStore.getState().dialogs[0].props as { missingScopes?: string[] }).missingScopes
    ).toEqual(['ai:write:budgeted']);
  });

  /**
   * GUARD 10 — the NACK's own predicate, half one: `requestId.length > 0`.
   *
   * Guard 3 covers a payload with NO requestId key at all. It does NOT cover an
   * EMPTY-STRING one, and that is a different branch: `resolveBuzzPurchaseRequest`
   * rejects `''` (its `length === 0` check), so the message lands in the same
   * never-hang block — where `raw.requestId.length > 0` is the only thing stopping a
   * reply addressed to the empty string.
   *
   * 🔴 MEASURED: relaxing that to `>= 0` survived the whole suite. A NACK on `''` is
   * not merely untidy — it is a reply the block cannot correlate (its transport keys
   * pending requests by id), so it is indistinguishable from the silent drop it was
   * supposed to replace while adding an unsolicited message to the channel.
   *
   * 🔴 COUNT ONLY `BUZZ_PURCHASE_RESULT` — see guard 3's note. Total received drifts
   * on BLOCK_INIT / TOKEN_REFRESH the host emits on its own schedule.
   */
  test('OPEN_BUZZ_PURCHASE with an EMPTY requestId is dropped silently (nothing to reply to)', async () => {
    renderWithProviders(<IframeHost {...baseProps} />);
    // Pre-ready: the branch under test is the never-hang block, which this reaches
    // whether the rejection came from the status or from the payload.
    await waitForMount();
    const replies = listenForReply();
    const buzzReplies = () => replies.received.filter((m) => m.type === 'BUZZ_PURCHASE_RESULT');

    // POSITIVE CONTROL: a well-formed pre-ready request IS NACKed, so a
    // BUZZ_PURCHASE_RESULT is observable on this host before the zero is read.
    postFromBlock('OPEN_BUZZ_PURCHASE', { requestId: 'rq_ctl_empty', suggestedAmount: 10 });
    await vi.waitFor(() => expect(buzzReplies()).toHaveLength(1));

    // The real case: a present-but-empty requestId.
    postFromBlock('OPEN_BUZZ_PURCHASE', { requestId: '', suggestedAmount: 1000 });

    await new Promise((r) => setTimeout(r, 150));
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    // Still exactly the control's reply — the empty-id post added none.
    expect(buzzReplies()).toHaveLength(1);
    replies.stop();
  });

  /**
   * GUARD 11 — the NACK's predicate, half two: `typeof raw.requestId === 'string'`.
   *
   * 🔴 THE TWO PAYLOADS HERE ARE NOT REDUNDANT, AND PICKING ONLY THE OBVIOUS ONE
   * LEAVES THE MUTANT ALIVE. Dropping the `typeof` check leaves
   * `raw.requestId.length > 0`:
   *
   *   • `requestId: 5` — `(5).length` is `undefined`, `undefined > 0` is false, so
   *     the mutant still sends nothing and a test built on this case alone passes
   *     against BOTH the fix and the mutant. It is here because it is the payload
   *     the `typeof` check nominally describes, not because it discriminates.
   *   • `requestId: ['rq']` — a structured-clonable value with a TRUTHY `.length`.
   *     This is the one that discriminates: without the `typeof` check the host
   *     replies with `requestId: ['rq']`, an id of a type the protocol does not
   *     have. MEASURED: dropping `typeof` survives the whole suite without it.
   *
   * Both are equally UNREPLIABLE by the PR's own stated invariant — there is no
   * string id to thread a reply back on — so both must be dropped in total silence.
   */
  test('OPEN_BUZZ_PURCHASE with a NON-STRING requestId is dropped silently (nothing to reply to)', async () => {
    renderWithProviders(<IframeHost {...baseProps} />);
    await waitForMount();
    const replies = listenForReply();
    const buzzReplies = () => replies.received.filter((m) => m.type === 'BUZZ_PURCHASE_RESULT');

    // POSITIVE CONTROL first — proves the handler is live and a NACK observable.
    postFromBlock('OPEN_BUZZ_PURCHASE', { requestId: 'rq_ctl_nonstring', suggestedAmount: 10 });
    await vi.waitFor(() => expect(buzzReplies()).toHaveLength(1));

    // A number: no `.length` at all.
    postFromBlock('OPEN_BUZZ_PURCHASE', { requestId: 5, suggestedAmount: 1000 });
    // An array: a non-string that DOES have a truthy `.length`.
    postFromBlock('OPEN_BUZZ_PURCHASE', { requestId: ['rq'], suggestedAmount: 1000 });

    await new Promise((r) => setTimeout(r, 150));
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    // Still exactly the control's reply — neither malformed post added one.
    expect(buzzReplies()).toHaveLength(1);
    replies.stop();
  });
});
