import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
// Type-only namespace import for the `importOriginal` spread below (the repo's
// local-rules/no-wholesale-module-mock cure).
import type * as TrpcMod from '~/utils/trpc';

/**
 * AN UNHANDLED REQUEST-STYLE MESSAGE GETS AN ERROR REPLY, ON THE REAL MODEL-SLOT HOST.
 *
 * 🔴 WHAT THIS PINS, AND WHY IT IS THE EXPENSIVE CASE. `IframeHost` deliberately
 * registers no handler for the page-only affordances — `GET_VIEWER` among them,
 * and `hostHandlerParity`'s INVENTORY says so in as many words ("viewer self-read
 * is a page-only affordance; slot-apps deferred"). Before this change the host's
 * answer to one of those was NOTHING: the dispatcher returned, the block's
 * `sendRequest` promise stayed pending, and it resolved only when the SDK's own
 * per-class timeout fired — 30s for the default class, 120s for workflow, and
 * TEN MINUTES for the human-in-the-loop class that `OPEN_IMAGE_UPLOAD` and
 * `CREATE_POST_FROM_APP` sit in. `PageBlockHost.tsx` says it plainly in-source:
 * "a silent drop strands the block's promise for ten minutes with no error
 * anywhere."
 *
 * 🔴 AND THE REPLY SHAPE IS NOT COSMETIC. The block's transport correlates a reply
 * STRICTLY by `payload.requestId` AND `data.type === pending.responseType`
 * (`iframeTransport.handleMessage`), and drops anything failing
 * `payloadValidatorFor(type)` first. So a generic "BRIDGE_ERROR" would be filed as
 * an unsolicited push with no listener and change nothing. The reply asserted here
 * is the type the protocol declares for `GET_VIEWER` carrying `{requestId, error}`,
 * which `isValidViewerResult` accepts (`viewer === undefined && error === undefined`
 * is its only reject) and the consuming hook throws on.
 *
 * The one-second bound is the POINT of the assertion, not a timeout knob: the
 * defect being closed is measured in tens of seconds to minutes, so a test that
 * merely asserted "a reply eventually arrives" would pass against a 30s hang.
 */

const { currentUser } = vi.hoisted(() => ({
  currentUser: { value: { id: 42 } as { id: number } | null },
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => currentUser.value }));

// This factory REPLACES the module, so it must name every export this file's
// module graph imports — including `useOptionalFeatureFlags`, which the app-block
// chrome reads. Omitting one makes the FILE fail to import, which reports as
// `Tests no tests` rather than as a failure.
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: false, appBlocksPages: false }),
  useOptionalFeatureFlags: () => ({ appBlocks: false, appBlocksPages: false }),
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: {
    collection: {
      follow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      unfollow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    blocks: {
      getEffectiveCheckpoint: {
        useQuery: () => ({ data: { checkpoint: null }, isLoading: false }),
      },
      getShowcaseImages: { useQuery: () => ({ data: [], isLoading: false }) },
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
      collection: { getById: { fetch: vi.fn() } },
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
// eslint-disable-next-line import/first
import { INVENTORY } from '~/components/AppBlocks/hostHandlerParity';
// eslint-disable-next-line import/first
import { _internalsForTests as beacon } from '~/components/AppBlocks/bridgeMessageBeacon';

const SAME_ORIGIN_SRC = `${window.location.origin}/`;

function iframeEl() {
  return page.getByTestId('block-iframe').element() as HTMLIFrameElement;
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

function listenForReply() {
  const received: Array<{ type: string; payload: unknown }> = [];
  const cw = iframeEl().contentWindow;
  if (!cw) throw new Error('iframe contentWindow missing');
  const handler = (e: MessageEvent) => {
    const d = e.data as { type?: string; payload?: unknown } | null;
    if (d && typeof d.type === 'string') received.push({ type: d.type, payload: d.payload });
  };
  cw.addEventListener('message', handler);
  return {
    of: (type: string) => received.filter((m) => m.type === type),
    stop: () => cw.removeEventListener('message', handler),
  };
}

const install: BlockInstall = {
  blockInstanceId: 'inst_test',
  blockId: 'my-model-app',
  appId: 'app_test',
  appBlockId: 'apb_test',
  manifest: {
    name: 'Slot App',
    scopes: [],
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

async function mountAndReady() {
  renderWithProviders(<IframeHost {...baseProps} />);
  await vi.waitFor(() => {
    if (!iframeEl().contentWindow) throw new Error('not mounted yet');
  });
  const replies = listenForReply();
  // POSITIVE CONTROL: the listener is proven to observe real host pushes before
  // any assertion rests on it — an assertion about what a channel carries is
  // worthless until the channel is shown to carry anything.
  await vi.waitFor(() => {
    if (replies.of('BLOCK_INIT').length === 0) throw new Error('listener saw no BLOCK_INIT');
  });
  await vi.waitFor(() => {
    postFromBlock('BLOCK_READY', {});
    if (iframeEl().getAttribute('data-block-ready') !== 'true') throw new Error('not ready yet');
  });
  return replies;
}

describe('IframeHost NACKs a page-only REQUEST-style message instead of hanging', () => {
  test('GET_VIEWER is declared N/A for this host — the premise of the test, not an assumption', () => {
    // If someone later wires GET_VIEWER into IframeHost, this test's subject stops
    // being an unhandled message and the assertion below would pass for the wrong
    // reason (a real VIEWER_RESULT). Pin the premise so that shows up here.
    expect(INVENTORY.GET_VIEWER.IframeHost).not.toBe('required');
    expect(INVENTORY.GET_VIEWER.request).toBe(true);
    expect(INVENTORY.GET_VIEWER.reply).toBe('VIEWER_RESULT');
  });

  test('the block receives an error reply in well under one second', async () => {
    const replies = await mountAndReady();

    const started = performance.now();
    postFromBlock('GET_VIEWER', { requestId: 'rq_viewer' });

    await vi.waitFor(
      () => {
        if (replies.of('VIEWER_RESULT').length === 0) throw new Error('no reply yet');
      },
      { timeout: 1000, interval: 5 }
    );
    const elapsed = performance.now() - started;

    // 🔴 THE BOUND IS THE ASSERTION. The defect this closes is measured in tens of
    // seconds to ten minutes, so "a reply eventually arrives" would pass against
    // the bug.
    expect(elapsed).toBeLessThan(1000);

    const reply = replies.of('VIEWER_RESULT')[0];
    expect(reply.payload).toEqual({
      requestId: 'rq_viewer',
      // `payload.requestId` is what the transport correlates on, and an error the
      // consuming hook throws on — not a silent empty success.
      error: 'unsupported on this host',
    });
    replies.stop();
  });

  test("the reply echoes the block's OWN requestId, or it correlates with nothing", async () => {
    const replies = await mountAndReady();
    postFromBlock('GET_IMAGES_BY_IDS', { requestId: 'rq_images_7', ids: [1, 2] });
    await vi.waitFor(
      () => {
        if (replies.of('IMAGES_RESULT').length === 0) throw new Error('no reply yet');
      },
      { timeout: 1000, interval: 5 }
    );
    expect(replies.of('IMAGES_RESULT')[0].payload).toMatchObject({ requestId: 'rq_images_7' });
    replies.stop();
  });

  test('a message with NO requestId is not answered — there is nothing to correlate to', async () => {
    // 🔴 NOT AN INVARIANT GUARD, despite passing at `origin/main` (where NOTHING
    // is answered). It DISCRIMINATES a real mutation of the new code: remove the
    // `typeof unhandledRequestId === 'string'` test in `usePostMessage`'s
    // no_handler branch and this goes red, because the host would then answer a
    // correlation-less message. Filed as regression coverage for that mutation,
    // not as evidence about the base.
    const replies = await mountAndReady();
    postFromBlock('GET_VIEWER', {});
    await new Promise((r) => setTimeout(r, 100));
    expect(replies.of('VIEWER_RESULT')).toHaveLength(0);
    replies.stop();
  });

  test('THE SEAM: a real mount, with no injected sink, reaches the real beacon buffer', async () => {
    // 🔴 THE DEFECT THIS CLOSES IS "VERIFIED IN ISOLATION". Every other test here
    // and in `usePostMessageOutcomes.browser.test.tsx` injects its own `onOutcome`,
    // the route test posts a synthetic body, and the beacon test calls
    // `recordBridgeMessage` directly — so all three surfaces were green while the
    // ONE wire between them was asserted nowhere. Measured consequence of that
    // gap: changing the hook's default sink to a no-op, or swapping the two hosts'
    // `host` labels, or passing `install.blockId` instead of `install.appBlockId`,
    // each SURVIVED the whole suite. The counter would then read a permanent flat
    // zero, which on a brand-new series is indistinguishable from a healthy bridge.
    beacon.reset();
    const replies = await mountAndReady();
    postFromBlock('GET_VIEWER', { requestId: 'rq_seam' });
    await vi.waitFor(() => {
      if (replies.of('VIEWER_RESULT').length === 0) throw new Error('no reply yet');
    });
    const rows = beacon.buffered();
    // The labels are read off the REAL host, not a harness prop — that is the
    // whole point: `host` is what tells a declared page-only N/A apart from a
    // missing bridge, and `app_block_id` is the attribution.
    expect(rows).toContainEqual(
      expect.objectContaining({
        appBlockId: 'apb_test',
        host: 'IframeHost',
        type: 'GET_VIEWER',
        outcome: 'no_handler',
      })
    );
    // …and the mount's own handled traffic is there too, so `no_handler` has a
    // denominator rather than being the only thing this host ever reports.
    expect(rows.some((r) => r.outcome === 'handled' && r.host === 'IframeHost')).toBe(true);
    replies.stop();
    beacon.reset();
  });
});
