import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
// Used INSIDE the hoisted `vi.mock` factory below. Safe: the factory is invoked
// lazily (on first import of the mocked module), long after this binding is
// initialised — an `await import('react')` inside the factory instead trips the
// browser mocker.
import { useState } from 'react';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * IframeHost — the COMMITTED loading→ready transition (model.sidebar_top).
 *
 * 🔴 THE BUG THIS FILE EXISTS FOR. The BLOCK_READY handler used to read the
 * transition out of the `setStatus` UPDATER:
 *
 *     let appliedReady = false;
 *     setStatus((current) => { if (current === 'loading') { appliedReady = true; … } });
 *     if (appliedReady) { notifyReady(); applyHeight(payload.height); …sendBlockRender… }
 *
 * React does NOT guarantee the updater runs before the next statement. It only
 * evaluates it eagerly as a bail-out optimisation, and ONLY when the fiber has no
 * other pending update. The moment any unrelated state update is already queued on
 * THIS component when BLOCK_READY lands, the eager path is skipped, the updater
 * runs later during render, `appliedReady` is still `false` at the `if`, and the
 * ENTIRE branch is skipped — three side effects lost at once:
 *   1. `applyHeight(payload.height)` — the iframe stays pinned at manifest
 *      `minHeight` (clipped block content, or a dead gap under a short block).
 *   2. `controllerRef.current?.notifyReady()` — the init controller is not told
 *      the block acked, so it keeps re-posting BLOCK_INIT until something else
 *      tears it down. (Impact is BOUNDED: `status` is in the init effect's dep
 *      array, so committing 'ready' re-runs that effect and its cleanup
 *      `dispose()`s the controller anyway — see the "never goes terminal" suite.)
 *   3. the `/api/track/block-render` impression beacon — silently dropped.
 * The fix moves 1+3 into an effect keyed on the COMMITTED `status`, and makes 2
 * unconditional (it is idempotent). PR #3457 applied the same shape to the
 * sibling PageBlockHost.
 *
 * 🔴 WHY THE EXISTING SUITE COULD NOT CATCH IT. IframeHost.browser.test.tsx
 * stubs every tRPC hook as a CONSTANT-returning function, which removes the very
 * batching condition the bug needs: the fiber is quiescent when BLOCK_READY
 * arrives, React takes the eager path, and the buggy code passes. So this file
 * mocks `useBrowsingLevelDebounced` (called directly by IframeHost, so its hooks
 * live on the IframeHost FIBER) with a REAL `useState` and exposes its setter.
 * That lets a test queue a genuine React update on the host and then deliver
 * BLOCK_READY in the SAME synchronous task — the real batched path, no faking of
 * React internals. Every other test here runs the un-batched path too, so both
 * scheduling shapes are pinned.
 *
 * Also covered: H-11 — a BLOCK_READY that loses the race to a terminal state must
 * apply nothing and emit no `ok` beacon. Read the note on the H-11 describe block
 * for which of those tests exercise the guard DIRECTLY (the batched
 * `BLOCK_ERROR{fatal}` pair) versus which pin only the terminal outcome
 * (`timeout` / `no_token`, where a late ack is undeliverable). Plus emit-once
 * semantics and untrusted-payload height validation.
 */

// `vi.mock` is hoisted, so the per-test levers must live in a hoisted block the
// factory can close over.
const mocks = vi.hoisted(() => ({
  /** Queue a real, IframeHost-fiber-local React update (the batching lever). */
  bump: null as null | (() => void),
}));

// The batching lever. IframeHost calls useBrowsingLevelDebounced() directly, so
// the useState below belongs to the IframeHost fiber and its setter schedules an
// update on exactly the fiber whose `setStatus` we care about. The RETURNED value
// stays constant (1) — it only feeds the mocked showcase query, so bumping is
// behaviourally inert and purely a scheduling lever.
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', () => ({
  useBrowsingLevelDebounced: () => {
    const [, setTick] = useState(0);
    mocks.bump = () => setTick((n) => n + 1);
    return 1;
  },
}));

// AppBlockChrome calls useCurrentUser() for the platform-nav moderator gate;
// this suite renders the real host without a CivitaiSessionProvider.
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

// IframeHost drives two tRPC queries at render plus the SDK bridges. Stub them so
// the host mounts network-free AND the init handshake is ALLOWED to start
// immediately (getEffectiveCheckpoint must report isLoading:false so
// `shouldStartInit` fires and the controller arms its readiness timeout).
vi.mock('~/utils/trpc', () => ({
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
        // Was MISSING: IframeHost calls `trpc.apps.shared.report.useMutation()`
        // unconditionally at render, so without this stub every test in this file
        // crashed at mount with "Cannot read properties of undefined (reading
        // 'useMutation')". These checks are report-only, so the whole suite — the
        // guard for the ready-transition / beacon-exclusivity invariants — had been
        // silently red.
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
import { IframeHost } from '~/components/AppBlocks/IframeHost';
// eslint-disable-next-line import/first
import { IframeInitController } from '~/components/AppBlocks/iframeInitController';
// eslint-disable-next-line import/first
import type { BlockInstall, ModelSlotContext } from '~/components/AppBlocks/types';

// Same-origin so trustTier='internal' yields a pinned (non-opaque) transport
// whose expectedOrigin equals this frame's origin, exactly like a verified/
// internal block. We post FROM the iframe's contentWindow so the
// `event.source === iframe.contentWindow` authenticating pin holds.
const SAME_ORIGIN_SRC = `${window.location.origin}/`;

const MIN_HEIGHT = 200;
const MAX_HEIGHT = 800;

const install: BlockInstall = {
  blockInstanceId: 'inst_test',
  blockId: 'my-model-app',
  appId: 'app_test',
  appBlockId: 'apb_test',
  manifest: {
    name: 'Background Remover',
    scopes: ['ai:write:budgeted'],
    iframe: {
      src: SAME_ORIGIN_SRC,
      minHeight: MIN_HEIGHT,
      maxHeight: MAX_HEIGHT,
      resizable: true,
      sandbox: 'allow-scripts',
    },
  },
  publisherSettings: {},
  enabled: true,
  renderMode: 'iframe',
  trustTier: 'internal',
};

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

const iframeEl = () => page.getByTestId('block-iframe').element() as HTMLIFrameElement;
const iframeQuery = () => page.getByTestId('block-iframe').query() as HTMLIFrameElement | null;

/** The height the host has actually applied to the iframe element. */
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

/** Un-batched drive to ready (the eager-updater path). */
async function driveToReady(payload: unknown = {}) {
  await waitForMount();
  await vi.waitFor(() => {
    postFromBlock('BLOCK_READY', payload);
    if (iframeEl().getAttribute('data-block-ready') !== 'true') throw new Error('not ready yet');
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── beacon plumbing ──────────────────────────────────────────────────────────
let fetchSpy: ReturnType<typeof vi.spyOn>;
// Direct observation of side effect #2. Counting BLOCK_INIT postMessages instead
// would be VACUOUS: when the same-origin iframe's document loads, the inner global
// is swapped out (the `WindowProxy` object identity is preserved, but the listener
// registered on the pre-load global is not), so a listener the test attaches never
// sees the host's posts — verified, it captured 0, meaning the assertion could
// never have failed. Spying the controller method the handler calls is the honest
// observable, and it IS the guard under test.
let notifyReadySpy: ReturnType<typeof vi.spyOn>;

function beaconBodies(): Array<Record<string, unknown>> {
  return (fetchSpy.mock.calls as unknown[][])
    .filter((c) => typeof c[0] === 'string' && (c[0] as string).includes('/api/track/block-render'))
    .map((c) => JSON.parse(String((c[1] as RequestInit).body)) as Record<string, unknown>);
}
const okBeacons = () => beaconBodies().filter((b) => b.status === undefined);
const errorBeacons = () => beaconBodies().filter((b) => b.status === 'error');

beforeEach(() => {
  mocks.bump = null;
  // vi.spyOn dedupes to the same mock when fetch is already spied, so its
  // .mock.calls would accumulate across tests — clear it each time.
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
  fetchSpy.mockClear();
  // spyOn calls through to the real implementation by default, so the controller
  // still genuinely stops its retry loop + readiness timeout.
  notifyReadySpy = vi.spyOn(IframeInitController.prototype, 'notifyReady');
  notifyReadySpy.mockClear();
});

describe('IframeHost ready transition — batched updates (the regression)', () => {
  test('a BLOCK_READY that lands with an unrelated update already queued STILL applies the height, stops the init retries, and emits exactly one ok beacon', async () => {
    renderWithProviders(<IframeHost {...baseProps} />);
    await waitForMount();
    expect(appliedHeight()).toBe(MIN_HEIGHT);
    expect(notifyReadySpy).not.toHaveBeenCalled();

    // 🔴 THE REPRO. Queue a real update on the IframeHost fiber, then deliver
    // BLOCK_READY in the SAME synchronous task — no await in between. React now
    // has pending work on this fiber, so it CANNOT take the eager-updater path,
    // which is exactly the condition under which the old
    // `let appliedReady = …; setStatus(u); if (appliedReady)` code silently
    // skipped all three side effects.
    if (!mocks.bump) throw new Error('batching lever not wired');
    mocks.bump();
    postFromBlock('BLOCK_READY', { height: 640 });

    // The status transition itself was never the broken part — it is the SIDE
    // EFFECTS that were lost, so assert each one.
    await vi.waitFor(() => {
      expect(iframeEl().getAttribute('data-block-ready')).toBe('true');
    });
    // 1. height applied (was: stuck at minHeight).
    await vi.waitFor(() => {
      expect(appliedHeight()).toBe(640);
    });
    // 3. exactly one impression beacon (was: silently dropped).
    await vi.waitFor(() => {
      expect(okBeacons()).toHaveLength(1);
    });
    expect(okBeacons()[0]).toEqual({
      appBlockId: 'apb_test',
      blockInstanceId: 'inst_test',
      slotId: 'model.sidebar_top',
    });
    expect(errorBeacons()).toHaveLength(0);

    // 2. the init controller was told the block acked, so it stops re-posting
    // BLOCK_INIT and cancels its readiness timeout (was: the ~400ms loop kept
    // firing until the 10s timeout stopped it).
    expect(notifyReadySpy).toHaveBeenCalledTimes(1);
  });

  test('the un-batched ack (eager-updater path) applies the height and emits one ok beacon too', async () => {
    // The scheduling shape that ALWAYS worked — pinned so the fix cannot regress
    // the common path while fixing the batched one.
    renderWithProviders(<IframeHost {...baseProps} />);
    await driveToReady({ height: 512 });
    await vi.waitFor(() => {
      expect(appliedHeight()).toBe(512);
    });
    await vi.waitFor(() => expect(okBeacons()).toHaveLength(1));
  });
});

describe('IframeHost ready transition — emit-once / apply-once semantics', () => {
  test('duplicate BLOCK_READY acks in ONE batch yield exactly one beacon and one height application (last ack wins)', async () => {
    renderWithProviders(<IframeHost {...baseProps} />);
    await waitForMount();

    // Three acks, same task. The first takes the eager path; the 2nd/3rd land
    // with the first's updates pending — the exact shape that used to drop them.
    postFromBlock('BLOCK_READY', { height: 300 });
    postFromBlock('BLOCK_READY', { height: 450 });
    postFromBlock('BLOCK_READY', { height: 610 });

    await vi.waitFor(() => {
      expect(iframeEl().getAttribute('data-block-ready')).toBe('true');
    });
    await vi.waitFor(() => {
      // The block's most recent statement of its own handshake height.
      expect(appliedHeight()).toBe(610);
    });
    await sleep(120);
    expect(okBeacons()).toHaveLength(1);
    expect(errorBeacons()).toHaveLength(0);
  });

  test('a later ack WITHOUT a usable height does not erase the height an earlier ack in the same batch supplied', async () => {
    // The regression direction of "last ack wins": a block that acks with a height
    // and then re-acks bare (or with a payload the shape guard reduces to `{}`)
    // must keep the height it actually stated. Both re-acks below land on
    // `payload.height === undefined`, so they exercise the same single branch —
    // they're belt-and-braces, not two separately-pinned routes. Without the `!== undefined` stash guard
    // the ref resets and the frame stays pinned at minHeight — a case the OLD code
    // got right (its eager path applied the FIRST ack), so this would have turned
    // the fix into a regression.
    renderWithProviders(<IframeHost {...baseProps} />);
    await waitForMount();

    postFromBlock('BLOCK_READY', { height: 640 });
    postFromBlock('BLOCK_READY', {});
    postFromBlock('BLOCK_READY', { width: 100 });

    await vi.waitFor(() => {
      expect(iframeEl().getAttribute('data-block-ready')).toBe('true');
    });
    await vi.waitFor(() => {
      expect(appliedHeight()).toBe(640);
    });
    await sleep(120);
    expect(okBeacons()).toHaveLength(1);
  });

  test('a duplicate ack AFTER the ready commit does not re-emit and does not clobber a negotiated RESIZE_IFRAME height', async () => {
    renderWithProviders(<IframeHost {...baseProps} />);
    await driveToReady({ height: 300 });
    await vi.waitFor(() => expect(okBeacons()).toHaveLength(1));

    // The block has since grown via the post-ready channel.
    postFromBlock('RESIZE_IFRAME', { height: 700 });
    await vi.waitFor(() => {
      expect(appliedHeight()).toBe(700);
    });

    // A late re-ack must not rewind the height to its handshake value, and must
    // not emit a second impression.
    postFromBlock('BLOCK_READY', { height: 300 });
    await sleep(150);
    expect(appliedHeight()).toBe(700);
    expect(okBeacons()).toHaveLength(1);
  });

  test('a manifest height change after ready does NOT re-run the ready commit and rewind a negotiated height', async () => {
    // The scenario `readyTransitionAppliedRef` exists for. `applyHeight` is a
    // useCallback over manifest min/maxHeight, so those values changing mid-mount
    // (a new approved version landing under an unpinned install) gives the
    // ready-commit effect a NEW dependency identity. Without the run-once guard
    // it re-runs while `status` is still 'ready' and re-applies the stale
    // HANDSHAKE height, silently rewinding a height the block had since
    // negotiated via RESIZE_IFRAME.
    const { rerender } = await renderWithProviders(<IframeHost {...baseProps} />);
    await driveToReady({ height: 260 });
    await vi.waitFor(() => expect(okBeacons()).toHaveLength(1));

    postFromBlock('RESIZE_IFRAME', { height: 700 });
    await vi.waitFor(() => {
      expect(appliedHeight()).toBe(700);
    });

    await rerender(
      <IframeHost
        {...baseProps}
        install={{
          ...install,
          manifest: {
            ...install.manifest,
            // Rebuilt (not spread) because `manifest.iframe` is optional, so
            // spreading it widens every field to `| undefined`.
            iframe: {
              src: SAME_ORIGIN_SRC,
              minHeight: MIN_HEIGHT,
              maxHeight: 900,
              resizable: true,
              sandbox: 'allow-scripts',
            },
          },
        }}
      />
    );
    await sleep(200);

    expect(appliedHeight()).toBe(700);
    expect(okBeacons()).toHaveLength(1);
  });

  test('ok and error beacons are mutually exclusive: a fatal AFTER ready emits no second beacon', async () => {
    // Pins the SHARED `blockRenderEmittedRef`. The ready-transition effect must
    // claim it, so the terminal-failure effect below it can never add a second
    // impression for the same mount.
    renderWithProviders(<IframeHost {...baseProps} />);
    await driveToReady({ height: 320 });
    await vi.waitFor(() => expect(okBeacons()).toHaveLength(1));

    postFromBlock('BLOCK_ERROR', { fatal: true });
    await vi.waitFor(() => {
      expect(iframeQuery()).toBeNull();
    });
    await sleep(150);
    expect(okBeacons()).toHaveLength(1);
    expect(errorBeacons()).toHaveLength(0);
    expect(beaconBodies()).toHaveLength(1);
  });
});

describe('IframeHost ready transition — untrusted height payload', () => {
  test('an ack with NO height leaves the iframe at the manifest minHeight and still completes the handshake', async () => {
    renderWithProviders(<IframeHost {...baseProps} />);
    await driveToReady({});
    await vi.waitFor(() => expect(okBeacons()).toHaveLength(1));
    expect(appliedHeight()).toBe(MIN_HEIGHT);
  });

  // The payload crosses an iframe boundary and is functionally untyped: the shape
  // guard reduces anything without a `height` key to `{}`, and `applyHeight`
  // rejects every non-finite / non-positive value. Either way the handshake must
  // still complete (a bad height is not a fatal error).
  test.each([
    ['a non-object payload', 'nope' as unknown],
    ['a null payload', null as unknown],
    ['no height key', { width: 400 } as unknown],
    ['a string height', { height: '640' } as unknown],
    ['NaN', { height: Number.NaN } as unknown],
    ['Infinity', { height: Number.POSITIVE_INFINITY } as unknown],
    ['zero', { height: 0 } as unknown],
    ['a negative height', { height: -900 } as unknown],
    ['a null height', { height: null } as unknown],
    ['an object height', { height: { valueOf: () => 640 } } as unknown],
  ])(
    '%s is rejected but the block still reaches ready with one beacon',
    async (_label, payload) => {
      renderWithProviders(<IframeHost {...baseProps} />);
      await driveToReady(payload);
      await vi.waitFor(() => expect(okBeacons()).toHaveLength(1));
      expect(appliedHeight()).toBe(MIN_HEIGHT);
    }
  );

  test('an over-ceiling height is clamped to the manifest maxHeight', async () => {
    renderWithProviders(<IframeHost {...baseProps} />);
    await driveToReady({ height: 999_999 });
    await vi.waitFor(() => {
      expect(appliedHeight()).toBe(MAX_HEIGHT);
    });
  });

  test('a height below the manifest minHeight is floored to minHeight', async () => {
    renderWithProviders(<IframeHost {...baseProps} />);
    await driveToReady({ height: 12 });
    await vi.waitFor(() => expect(okBeacons()).toHaveLength(1));
    expect(appliedHeight()).toBe(MIN_HEIGHT);
  });
});

describe('IframeHost ready transition — H-11: a late BLOCK_READY after a terminal state', () => {
  // 🔴 THE INVARIANT the buggy code was (correctly) trying to protect, and which
  // the fix must not trade away: once the host has landed on `timeout` / `fatal` /
  // `no_token`, a BLOCK_READY that arrives afterwards must apply NO height, emit
  // NO `ok` beacon, and never revive `ready`. It is now STRUCTURAL rather than a
  // timing observation — the ready-transition effect early-returns on
  // `status !== 'ready'`, and `status` can only become 'ready' from 'loading'.
  //
  // Note on IframeHost's terminal shape (it diverges from PageBlockHost): every
  // terminal state COLLAPSES the host to null (hostRenderDecision) rather than
  // rendering a framed BlockFallback, so `block-iframe` is gone — which is how
  // FRAME-1 is satisfied here (nothing rendered ⇒ nothing to masquerade as).
  //
  // CONSEQUENCE FOR HOW THESE TESTS ARE WRITTEN — read before adding one.
  // Because the host collapses, a BLOCK_READY dispatched AFTER a terminal state is
  // UNDELIVERABLE, not merely ignored: `usePostMessage` pins
  // `event.source === iframeRef.current?.contentWindow`, and once the iframe
  // unmounts that comparand is `undefined` while `MessageEvent.source` is never
  // `undefined` (absent → `null`) — so NO source value can pass and the message is
  // dropped before the BLOCK_READY handler runs. Two things follow:
  //   - The late `dispatchEvent` in the `timeout` / `no_token` tests below is a
  //     NO-OP that asserts nothing on its own — nothing there distinguishes
  //     "dropped at the transport" from "delivered and correctly ignored". Treat it
  //     as documentation of the scenario, not as coverage.
  //   - Those tests still have real teeth, just from a different line: their
  //     terminal-OUTCOME assertions (exactly one `error` beacon of the right class,
  //     no `ok` beacon, host collapsed). Removing the ready effect's
  //     `status !== 'ready'` guard fails BOTH of them, because the ready effect then
  //     fires at mount, claims the shared `blockRenderEmittedRef`, and the failure
  //     beacon never gets to fire. (Verified: that mutation fails 10 of the 25 tests
  //     in this file, these two included.)
  // The guard is *directly* exercised — ack genuinely delivered, status genuinely
  // terminal — only by the two BATCHED `BLOCK_ERROR{fatal}` cases, where both
  // messages arrive while the iframe is still mounted. Prefer that shape when
  //   adding H-11 coverage.

  test('BLOCK_ERROR{fatal} batched with a BLOCK_READY in the same task stays fatal: no height, no ok beacon, only the error beacon', async () => {
    // The DELIVERABLE H-11 case — both messages are dispatched while the iframe
    // is still mounted, so both really reach the host's handlers, and the
    // BLOCK_READY lands with the fatal transition already queued (no eager path).
    renderWithProviders(<IframeHost {...baseProps} />);
    await waitForMount();

    postFromBlock('BLOCK_ERROR', { fatal: true });
    postFromBlock('BLOCK_READY', { height: 640 });

    // Collapsed → the whole host renders null.
    await vi.waitFor(() => {
      expect(iframeQuery()).toBeNull();
    });
    // The mutually-exclusive FAILURE beacon fired; the ok beacon never did. (If a
    // regression re-ran the ready side effects unconditionally, the ok beacon
    // would claim the shared emit-once ref and this would flip.)
    await vi.waitFor(() => {
      expect(errorBeacons()).toHaveLength(1);
    });
    expect(errorBeacons()[0]).toMatchObject({ status: 'error', errorClass: 'fatal' });
    expect(okBeacons()).toHaveLength(0);
  });

  test('the readiness TIMEOUT is terminal: error beacon only, host collapsed, and a late ack is not even deliverable', async () => {
    // NOT a test of the effect's status guard — see the describe-block note: once
    // the host collapses the ack cannot reach a handler at all. What this pins is
    // the terminal OUTCOME (exactly one `error` beacon, classed 'timeout', never an
    // `ok` one) and that a late ack leaves it that way. Killed by M3 (removing the
    // status guard makes the ready effect fire at mount and claim the shared
    // emit-once ref, so the error beacon never gets to fire).
    renderWithProviders(<IframeHost {...baseProps} />);
    await waitForMount();
    // Never ack → the controller's ~10s readiness timeout fires → 'timeout'.
    await vi.waitFor(
      () => {
        expect(iframeQuery()).toBeNull();
      },
      { timeout: 14_000, interval: 250 }
    );
    await vi.waitFor(() => expect(errorBeacons()).toHaveLength(1));
    expect(errorBeacons()[0]).toMatchObject({ errorClass: 'timeout' });

    // A late ack (the block finally woke up). Documentation only — see the
    // describe-block note: post-collapse there is no iframe to pin to, so no
    // `source` value can pass the transport and this asserts nothing by itself.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'BLOCK_READY', payload: { height: 640 } },
        origin: window.location.origin,
      })
    );
    await sleep(200);
    expect(okBeacons()).toHaveLength(0);
    expect(errorBeacons()).toHaveLength(1);
    expect(iframeQuery()).toBeNull();
  }, 22_000);

  test('NO_TOKEN is terminal: error beacon only, and a late ack is not even deliverable', async () => {
    // An empty token never satisfies `shouldStartInit`, so the independent
    // token-wait timer (~15s) is what goes terminal here. Same coverage note as
    // the timeout case above — outcome, not guard.
    renderWithProviders(<IframeHost {...baseProps} token="" />);
    await waitForMount();
    await vi.waitFor(
      () => {
        expect(iframeQuery()).toBeNull();
      },
      { timeout: 19_000, interval: 250 }
    );
    await vi.waitFor(() => expect(errorBeacons()).toHaveLength(1));
    expect(errorBeacons()[0]).toMatchObject({ errorClass: 'no_token' });

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'BLOCK_READY', payload: { height: 640 } },
        origin: window.location.origin,
      })
    );
    await sleep(200);
    expect(okBeacons()).toHaveLength(0);
    expect(errorBeacons()).toHaveLength(1);
  }, 28_000);

  test('BLOCK_READY then BLOCK_ERROR{fatal} in the same batch resolves to fatal — the error beacon, not the ok beacon', async () => {
    // The REVERSE order of the case above, and a genuine behaviour change vs
    // `main`: there the handler emitted `ok` synchronously before the fatal was
    // processed, so `error` was suppressed by the shared emit-once ref. Now both
    // updaters run in one render, the committed status is 'fatal', and the ready
    // effect early-returns — so the mount is reported as a FAILED render. Pinned
    // because it moves BlockRenderFailureRate, and declared in the PR body.
    renderWithProviders(<IframeHost {...baseProps} />);
    await waitForMount();

    postFromBlock('BLOCK_READY', { height: 640 });
    postFromBlock('BLOCK_ERROR', { fatal: true });

    await vi.waitFor(() => {
      expect(iframeQuery()).toBeNull();
    });
    await vi.waitFor(() => {
      expect(errorBeacons()).toHaveLength(1);
    });
    expect(errorBeacons()[0]).toMatchObject({ status: 'error', errorClass: 'fatal' });
    expect(okBeacons()).toHaveLength(0);
  });
});

describe('IframeHost ready transition — a ready block must never go terminal', () => {
  test('a block that acked BLOCK_READY (under batching) still shows no timeout past the readiness window', async () => {
    // The consequence chain worth pinning. Skipping `notifyReady()` leaves the
    // controller's readiness timeout armed — but a ready block still cannot be
    // flipped to 'timeout', because THREE independent guards each prevent it:
    //   1. `notifyReady()` → `stop()` clears the timeout (the direct path);
    //   2. `status` is in the init effect's dep array, so committing 'ready'
    //      re-runs it → the cleanup `dispose()`s the controller and
    //      `shouldStartInit` then refuses to make a new one. This one fires even
    //      if (1) is skipped, and is the reason the impact of the reported bug
    //      stops at "wasted BLOCK_INIT re-posts in the commit window";
    //   3. `onReadyTimeout` is itself `current === 'loading'`-guarded.
    // Assert the CONTRACT rather than any one mechanism: a ready block stays
    // rendered, keeps its height, and emits no error beacon well past
    // BLOCK_READY_TIMEOUT_MS. (Mutation-verified: breaking all three — see M11 in
    // the PR body — fails this test; breaking any two still passes.)
    renderWithProviders(<IframeHost {...baseProps} />);
    await waitForMount();
    if (!mocks.bump) throw new Error('batching lever not wired');
    mocks.bump();
    postFromBlock('BLOCK_READY', { height: 420 });

    await vi.waitFor(() => {
      expect(iframeEl().getAttribute('data-block-ready')).toBe('true');
    });
    await vi.waitFor(() => expect(okBeacons()).toHaveLength(1));

    await sleep(12_000);

    expect(iframeQuery()).not.toBeNull();
    expect(iframeEl().getAttribute('data-block-ready')).toBe('true');
    expect(appliedHeight()).toBe(420);
    expect(errorBeacons()).toHaveLength(0);
    expect(okBeacons()).toHaveLength(1);
  }, 22_000);
});
