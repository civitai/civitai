import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { useDialogStore } from '~/components/Dialog/dialogStore';
import type { BlockUploadedImageInfo } from '~/components/AppBlocks/BlockImageUploadModal';
import type { BlockSourceImageInfo } from '~/components/AppBlocks/BlockGenerationSourceUploadModal';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { onReadyAttributeWrite } from '../../../test/commitWindow';

/**
 * App Blocks PAGE image upload (OPEN_IMAGE_UPLOAD) — the host-handler BRANCH test.
 *
 * A full-page App Block posts OPEN_IMAGE_UPLOAD; the optional `purpose` selects
 * which host modal opens and which reply shape comes back:
 *   • 'display' (default / absent) → the MODERATED BlockImageUploadModal
 *     (createImage + scan + SFW gate) → { imageId, nsfwLevel, contentRating, url }.
 *   • 'generationSource' → the UNSCANNED BlockGenerationSourceUploadModal
 *     (uploadConsumerBlob, NO createImage/scan/gate) → { url, width, height }.
 *
 * These tests mount the REAL PageBlockHost and drive the actual postMessage
 * bridge. Following the OPEN_RESOURCE_PICKER test pattern, the dynamic-import
 * modals aren't rendered here; we assert the host opened the CORRECT modal (by
 * dialog id) and invoke its captured `onResolved` to simulate the user's upload,
 * then assert the IMAGE_UPLOAD_RESULT reply shape. The correct-modal assertion is
 * itself the proof that generationSource does NOT hit the moderated scan/gate
 * path (it opens the consumer-blob modal, never BlockImageUploadModal), and that
 * 'display' is unchanged. The modal-internal upload behavior (that
 * generationSource uses uploadConsumerBlob and never calls blockImageUpload) is
 * covered directly in BlockGenerationSourceUploadModal.browser.test.tsx.
 */

// Stub trpc so PageBlockHost mounts network-free (same shape as the resource-
// picker test). The image-upload branch itself makes no tRPC call from the host —
// the moderated path's persist/gate live INSIDE the (unrendered) modal.
// AppBlockChrome (in the host frame) calls useCurrentUser() for the platform-nav
// moderator gate; these suites render the real host without a CivitaiSessionProvider.
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

vi.mock('~/utils/trpc', () => ({
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

function postFromBlock(type: string, payload?: unknown) {
  const iframeEl = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
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

function listenForReply() {
  const received: Array<{ type: string; payload: unknown }> = [];
  const iframeEl = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
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

function lastDialog() {
  const dialogs = useDialogStore.getState().dialogs;
  if (dialogs.length === 0) throw new Error('no modal opened');
  return dialogs[dialogs.length - 1];
}

const SAME_ORIGIN_SRC = `${window.location.origin}/`;

const baseProps = {
  appBlockId: 'apb_test',
  blockId: 'my-page-app',
  appId: 'app_test',
  blockInstanceId: 'page_apb_test',
  appName: 'Gen App',
  iframeSrc: SAME_ORIGIN_SRC,
  // The public run surface. Required since the init-fragment gate keys on it.
  surface: 'page-run' as const,
  // Required. These suites cover the DEFAULT (host-veil) presentation;
  // the bootSkeleton path is covered in PageBlockHostLaunchReveal.
  bootSkeleton: false,
  sandbox: 'allow-scripts',
  trustTier: 'internal' as const,
  slug: 'my-page-app',
  token: 'tok_abc',
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  declaredScopes: ['ai:write:budgeted'],
  missingScopes: [] as string[],
  needsConsent: false,
  tokenError: false,
  viewer: { id: 42, username: 'tester' },
  theme: 'light' as const,
};

async function driveToReady() {
  await vi.waitFor(() => {
    const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
    if (!el.contentWindow) throw new Error('not mounted yet');
  });
  await vi.waitFor(() => {
    postFromBlock('BLOCK_READY', {});
    const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
    if (el.getAttribute('data-block-ready') !== 'true') throw new Error('not ready yet');
  });
}

/**
 * Wait for the iframe to mount, then post BLOCK_READY on a CANCELLABLE interval.
 * Used by the commit-window guard, which must NOT await readiness before acting —
 * the whole point is to act during the commit that establishes it. Callers stop the
 * drive in a `finally` so it can never post into the next test's host.
 */
async function startReadyDrive() {
  await vi.waitFor(() => {
    const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
    if (!el.contentWindow) throw new Error('not mounted yet');
  });
  const timer = setInterval(() => postFromBlock('BLOCK_READY', {}), 10);
  postFromBlock('BLOCK_READY', {});
  return () => clearInterval(timer);
}

/**
 * Post OPEN_IMAGE_UPLOAD after the host is ready and return the requestId used.
 *
 * ── HISTORY, because RETIRING the workaround is the point ────────────────────────
 *
 * This used to be a RETRY LOOP that re-posted with a FRESH `requestId` until the host
 * accepted one, and its comment called both halves load-bearing. It was a TEST-SIDE
 * workaround for a PRODUCTION bug (civitai#3659: the same commit `f1044a1446` ran the
 * component suite three times — twice `1280 passed`, once `1 failed | 1279 passed`
 * with this file's first test failing at 11205ms). The host's OPEN_IMAGE_UPLOAD
 * listener closed over `status`, so it dropped messages until a passive effect
 * re-registered it, and `data-block-ready === 'true'` was NOT evidence the handler was
 * live.
 *
 * The host now reads a render-body-updated `statusRef`, so the handler IS live at the
 * instant the attribute is written and the retry can never take a second attempt. It
 * is deleted rather than left in place: an inert retry whose comment insists it is
 * load-bearing is a false claim about current behaviour, and the next person to hit a
 * similar flake would copy it. The one-shot post below now FAILS LOUDLY if the host
 * ever drops a post-ready request again — which is the regression signal we want.
 *
 * The claim about the transport's 5s `requestId` dedup that used to live here is gone
 * too, and not because the dedup was removed: it is real in `usePostMessage` but
 * UNREACHABLE from the SDK, whose `nextRequestId()` is `random6 + a monotonic
 * counter`, so every call mints a fresh id and the window can never see a repeat.
 *
 * The dialog store is written synchronously from the message handler, so checking
 * immediately after the dispatch is correct: an accepted post is visible at once.
 */
function openUploadModal(payload: Record<string, unknown> = {}) {
  const requestId = 'rq_1';
  useDialogStore.getState().closeAll();
  postFromBlock('OPEN_IMAGE_UPLOAD', { requestId, ...payload });
  if (useDialogStore.getState().dialogs.length !== 1) {
    throw new Error('OPEN_IMAGE_UPLOAD opened no modal — the host dropped a post-ready request');
  }
  return requestId;
}

describe('PageBlockHost OPEN_IMAGE_UPLOAD (purpose branch)', () => {
  beforeEach(() => {
    useDialogStore.getState().closeAll();
  });

  /**
   * REGRESSION GUARD for the civitai#3659 flake. It used to pin `openUploadModal`'s
   * fresh-id RETRY — a test-side workaround. It now pins the PRODUCTION fix: the host
   * reading a render-body-updated `statusRef` instead of a closed-over `status`.
   *
   * 🔴 The post is driven from `onReadyAttributeWrite`, NOT the MutationObserver this
   * guard originally used — see test/commitWindow.tsx. The observer's callback is a
   * microtask that runs at the END of the scheduler task, by which point React has
   * often already flushed the passive effects; measured, the observer-driven version
   * of this guard survived the mutant roughly one run in three. The old comment's
   * "it can never false-FAIL" was an admission of exactly that: a guard that silently
   * degrades to a no-op is not a regression test. `setAttribute` is on React's own
   * call stack, so there is no queue to lose a race to.
   */
  test("a request posted in React's commit→passive-effect gap still opens the modal", async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    let opened: string | number | symbol | null = null;
    const unpatch = onReadyAttributeWrite(() => {
      postFromBlock('OPEN_IMAGE_UPLOAD', { requestId: 'rq_gap', purpose: 'generationSource' });
      opened = useDialogStore.getState().dialogs[0]?.id ?? null;
    });
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
    // Asserted on the value captured INSIDE the window, so this cannot pass on a
    // dialog that only appeared after the passive flush.
    expect(opened).toBe('block-generation-source-upload-rq_gap');
  });

  test('generationSource opens the UNSCANNED consumer-blob modal (NOT the moderated one) and replies { url, width, height }', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    const requestId = openUploadModal({ purpose: 'generationSource' });

    // The generationSource branch opens the generation-source modal — proof it
    // does NOT route to the moderated scan/gate modal.
    expect(lastDialog().id).toBe(`block-generation-source-upload-${requestId}`);
    expect(lastDialog().id).not.toBe(`block-image-upload-${requestId}`);

    // Simulate a successful consumer-blob upload inside the modal.
    const onResolved = (lastDialog().props as { onResolved: (r: BlockSourceImageInfo) => void })
      .onResolved;
    const source: BlockSourceImageInfo = {
      url: 'https://orchestration.civitai.com/v2/consumer/blobs/ABC123.jpeg?sig=x&exp=2030-01-01T00:00:00Z',
      width: 768,
      height: 512,
    };
    onResolved(source);
    // The modal closes itself after a successful upload → the dialog's
    // options.onClose (where the host posts the reply) fires.
    lastDialog().options?.onClose?.();

    await vi.waitFor(() => {
      const r = replies.last('IMAGE_UPLOAD_RESULT');
      if (!r) throw new Error('no reply yet');
      // EXACTLY the source projection — no imageId / nsfwLevel / contentRating.
      expect(r.payload).toEqual({ requestId, selected: source });
    });
    const sel = (
      replies.last('IMAGE_UPLOAD_RESULT')!.payload as { selected: Record<string, unknown> }
    ).selected;
    expect(Object.keys(sel).sort()).toEqual(['height', 'url', 'width']);
    for (const k of ['imageId', 'nsfwLevel', 'contentRating']) expect(sel).not.toHaveProperty(k);
    replies.stop();
  });

  test('display (explicit) opens the MODERATED modal and replies the moderated projection (unchanged)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    const requestId = openUploadModal({ purpose: 'display' });

    expect(lastDialog().id).toBe(`block-image-upload-${requestId}`);

    const onResolved = (lastDialog().props as { onResolved: (r: BlockUploadedImageInfo) => void })
      .onResolved;
    const moderated: BlockUploadedImageInfo = {
      imageId: 55,
      nsfwLevel: 1,
      contentRating: 'PG' as BlockUploadedImageInfo['contentRating'],
      url: 'https://image.civitai.com/xG/55/original.jpeg',
    };
    onResolved(moderated);
    lastDialog().options?.onClose?.();

    await vi.waitFor(() => {
      const r = replies.last('IMAGE_UPLOAD_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId, selected: moderated });
    });
    replies.stop();
  });

  test("an ABSENT purpose defaults to the moderated 'display' modal (SDK back-compat)", async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();

    // Exactly what the current SDK sends today: a bare requestId, no purpose.
    const requestId = openUploadModal();

    expect(lastDialog().id).toBe(`block-image-upload-${requestId}`);
  });

  test('generationSource cancel (close without upload) posts a bare (cancelled) result', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    const requestId = openUploadModal({ purpose: 'generationSource' });

    // User dismisses without a successful upload — onResolved never called, so
    // the dialog's options.onClose posts a bare (cancelled) result.
    lastDialog().options?.onClose?.();

    await vi.waitFor(() => {
      const r = replies.last('IMAGE_UPLOAD_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId });
    });
    replies.stop();
  });

  test('a request with no requestId is dropped (no modal, no reply) regardless of purpose', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    // 🔴 POSITIVE CONTROL, and it is not optional. This test asserts a request is
    // DROPPED — a zero. A host whose OPEN_IMAGE_UPLOAD listener is not live yet drops
    // it just as thoroughly (see openUploadModal), so without first proving the
    // listener ACCEPTS a well-formed request, both assertions below are green for the
    // wrong reason and the missing-requestId guard is never actually exercised.
    // `closeAll` does not run `options.onClose`, so this cannot post a reply of its own
    // — re-asserted immediately, so a future change that made it reply would be caught
    // here rather than silently satisfying the real assertion further down.
    openUploadModal({ purpose: 'generationSource' });
    useDialogStore.getState().closeAll();
    expect(replies.last('IMAGE_UPLOAD_RESULT')).toBeUndefined();

    postFromBlock('OPEN_IMAGE_UPLOAD', { purpose: 'generationSource' });

    await new Promise((r) => setTimeout(r, 150));
    expect(useDialogStore.getState().dialogs).toHaveLength(0);
    expect(replies.last('IMAGE_UPLOAD_RESULT')).toBeUndefined();
    replies.stop();
  });
});
