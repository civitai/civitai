import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { useDialogStore } from '~/components/Dialog/dialogStore';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { expectReplyKeys } from '../../../test/expectReplyKeys';
import {
  SAVE_BYTES_MAX_PER_WINDOW,
  SAVE_BYTES_WINDOW_MS,
  SAVE_IMAGE_MAX_CONCURRENT,
} from '~/components/AppBlocks/saveImageDownload';

/**
 * App Blocks SHARED (cross-user / app-global) storage bridge — host side (Phase 2b).
 *
 * A full-page App Block (`/apps/run/<slug>`, entity=none) that uses the SHARED
 * datastore drives it through the @civitai/app-sdk shared-storage hook, which
 * posts SHARED_LIST / GET_COUNT / GET_COUNTS / APPEND / VOTE / UNVOTE / WITHDRAW
 * and AWAITS the matching SHARED_*_RESULT. Unhandled ⇒ the block hangs to the SDK
 * 30s timeout (the same "spins forever, no network call, no error" class as the
 * per-user APP_STORAGE gap). PageBlockHost bridges each to `trpc.apps.shared.*`.
 *
 * The SHARED_* forwards themselves — call args, host-token precedence, every
 * reply shape, rate-limit metadata, no-token / review variants, and the
 * invalidate-BEFORE-reply ordering — are pinned row by row in
 * `test/bridgeForwardMatrix.ts` (run by `PageBlockHostForwardMatrix` and
 * `IframeHostForwardMatrix`). What remains here is what the matrix does not
 * assert: SAVE_IMAGE (the host download bridge) and the invalidation-FAILURE
 * case (a swallowed invalidate error must still report the write as succeeded).
 *
 * trpc is mocked via `vi.mock('~/utils/trpc')` (the scaffold's documented
 * pattern) so this stays network-free. Replies are captured on the iframe's
 * contentWindow `message` channel — identical to the APP_STORAGE test.
 */

// Per-test-controllable proc impls. `vi.mock` is hoisted, so the fns live in a
// hoisted block the factory closes over. Reads go through trpc.useUtils()...fetch;
// writes through trpc.apps.shared.{append,vote,unvote,withdraw}.useMutation().mutateAsync.
const mocks = vi.hoisted(() => ({
  // shared reads
  list: vi.fn(),
  get: vi.fn(),
  getCount: vi.fn(),
  getCounts: vi.fn(),
  // shared read-cache invalidation (apps.shared namespace-level)
  invalidate: vi.fn(),
  // shared writes
  append: vi.fn(),
  update: vi.fn(),
  vote: vi.fn(),
  unvote: vi.fn(),
  withdraw: vi.fn(),
  report: vi.fn(),
  // gated cross-user image read (backs the SAVE_IMAGE id variant)
  getImagesByIds: vi.fn(),
  // the top-frame blob download (stubbed so no real network fetch in the test);
  // the origin allowlist + request parse stay REAL (see the partial mock below).
  saveDownload: vi.fn(),
  saveBytesDownload: vi.fn(),
  // per-user storage reads/writes (also wired at render; inert here)
  storageGet: vi.fn(),
  storageSet: vi.fn(),
  storageDelete: vi.fn(),
  storageList: vi.fn(),
  storageGetQuota: vi.fn(),
  storageInvalidate: vi.fn(),
}));

// AppBlockChrome (in the host frame) calls useCurrentUser() for the platform-nav
// moderator gate; these suites render the real host without a CivitaiSessionProvider.
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

// Partial mock: keep the REAL origin allowlist + filename sanitizer + request
// parser (the security-critical pure logic), stub ONLY the top-frame blob
// download so the SAVE_IMAGE tests never hit the network.
vi.mock('~/components/AppBlocks/saveImageDownload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./saveImageDownload')>();
  return {
    ...actual,
    downloadUrlAsBlob: mocks.saveDownload,
    downloadBytesAsBlob: mocks.saveBytesDownload,
  };
});

vi.mock('~/utils/trpc', () => ({
  // FeatureFlagsProvider (in PageBlockHost's real render graph) statically imports
  // `setTrpcBatchingEnabled` from this module (#2946). vi.mock replaces the module
  // wholesale, so the factory must re-declare it or the ESM link fails.
  setTrpcBatchingEnabled: vi.fn(),
  trpc: {
    // Collection follow/unfollow host bridge (SET_COLLECTION_FOLLOW). Both
    // hosts register the handler, so every host-rendering suite needs these
    // two session-authed mutations present on the mocked client.
    collection: {
      follow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      unfollow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    // W13 wildcard-pack import: PageBlockHost now calls this at render; stub so the mount succeeds (behavior covered in PageBlockHostWildcardPack.browser.test.tsx).
    generation: {
      resolveWildcardPack: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      resolveResourceFile: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    // PageBlockHost also wires the workflow bridge at render (inert here); stub so
    // it mounts.
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
      // CREATE_POST_FROM_APP is TWO block-token mutations — the read-only preview
      // that resolves the consent payload, and the write. PageBlockHost reads both
      // at render, so a mock missing either makes the WHOLE component throw and
      // every measurement in the file reads as an empty DOM.
      previewPostFromApp: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      createPostFromApp: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getImagesByIds: { useMutation: () => ({ mutateAsync: mocks.getImagesByIds }) },
    },
    apps: {
      storage: {
        set: { useMutation: () => ({ mutateAsync: mocks.storageSet }) },
        delete: { useMutation: () => ({ mutateAsync: mocks.storageDelete }) },
      },
      shared: {
        append: { useMutation: () => ({ mutateAsync: mocks.append }) },
        update: { useMutation: () => ({ mutateAsync: mocks.update }) },
        vote: { useMutation: () => ({ mutateAsync: mocks.vote }) },
        unvote: { useMutation: () => ({ mutateAsync: mocks.unvote }) },
        withdraw: { useMutation: () => ({ mutateAsync: mocks.withdraw }) },
        report: { useMutation: () => ({ mutateAsync: mocks.report }) },
      },
    },
    useUtils: () => ({
      apps: {
        storage: {
          get: { fetch: mocks.storageGet },
          list: { fetch: mocks.storageList },
          getQuota: { fetch: mocks.storageGetQuota },
          invalidate: mocks.storageInvalidate,
        },
        shared: {
          list: { fetch: mocks.list },
          get: { fetch: mocks.get },
          getCount: { fetch: mocks.getCount },
          getCounts: { fetch: mocks.getCounts },
          // Router-level invalidate: what the hosts call after every shared
          // WRITE so the next read is not served from the staleTime:Infinity
          // cache. Present on the real utils; omitting it here would let a
          // broken wiring pass silently (the helper swallows throws by design).
          invalidate: mocks.invalidate,
        },
      },
    }),
  },
}));

// eslint-disable-next-line import/first
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';

// Dispatch a message FROM the host iframe: source = iframe.contentWindow,
// origin = host expectedOrigin (same-origin src). Satisfies both authenticating
// pins usePostMessage enforces.
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

// Capture host→block replies. `send` posts onto the iframe's contentWindow.
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

const SAME_ORIGIN_SRC = `${window.location.origin}/`;

const baseProps = {
  appBlockId: 'apb_test',
  blockId: 'my-page-app',
  appId: 'app_test',
  blockInstanceId: 'page_apb_test',
  appName: 'Requests',
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
  declaredScopes: ['apps:storage:shared:read', 'apps:storage:shared:write'],
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

describe('PageBlockHost SHARED storage bridge (Phase 2b cross-user datastore)', () => {
  beforeEach(() => {
    mocks.list.mockReset();
    mocks.get.mockReset();
    mocks.getCount.mockReset();
    mocks.getCounts.mockReset();
    mocks.append.mockReset();
    mocks.update.mockReset();
    mocks.vote.mockReset();
    mocks.unvote.mockReset();
    mocks.withdraw.mockReset();
    mocks.report.mockReset();
    mocks.invalidate.mockReset();
    mocks.invalidate.mockResolvedValue(undefined);
    mocks.getImagesByIds.mockReset();
    mocks.saveDownload.mockReset();
    mocks.saveBytesDownload.mockReset();
    useDialogStore.getState().closeAll();
  });

  // ── item 1: SAVE_IMAGE (host download bridge) ────────────────────────────────
  test('SAVE_IMAGE url variant: an ALLOWLISTED civitai origin downloads + replies ok', async () => {
    mocks.saveDownload.mockResolvedValue(undefined);
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SAVE_IMAGE', {
      requestId: 'rq_save_url',
      url: 'https://image.civitai.com/xG/77/original.jpeg',
      filename: 'render.png',
    });

    await vi.waitFor(() => {
      expect(mocks.saveDownload).toHaveBeenCalledWith(
        'https://image.civitai.com/xG/77/original.jpeg',
        'render.png'
      );
    });
    await vi.waitFor(() => {
      const r = replies.last('SAVE_IMAGE_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_save_url', ok: true });
      expectReplyKeys('SAVE_IMAGE', 'success', ['ok'], r.payload);
    });
    replies.stop();
  });

  test('SAVE_IMAGE url variant: an ARBITRARY origin is REFUSED (ok:false, NO download)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SAVE_IMAGE', { requestId: 'rq_save_evil', url: 'https://evil.example/x.png' });

    await vi.waitFor(() => {
      const r = replies.last('SAVE_IMAGE_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({
        requestId: 'rq_save_evil',
        ok: false,
        error: 'image url is not allowed',
      });
      expectReplyKeys('SAVE_IMAGE', 'error', ['error', 'ok'], r.payload);
    });
    // The disallowed URL was NEVER fetched host-side.
    expect(mocks.saveDownload).not.toHaveBeenCalled();
    replies.stop();
  });

  test('SAVE_IMAGE id variant: a VISIBLE image routes through the gated read + downloads', async () => {
    mocks.getImagesByIds.mockResolvedValue({
      images: [
        {
          imageId: 55,
          status: 'visible',
          nsfwLevel: 1,
          contentRating: 'g',
          url: 'https://image.civitai.com/edge/55.jpeg',
          width: 512,
          height: 512,
        },
      ],
    });
    mocks.saveDownload.mockResolvedValue(undefined);
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SAVE_IMAGE', { requestId: 'rq_save_id', imageId: 55 });

    await vi.waitFor(() => {
      // Routed through the SAME gated per-viewer read (host token bound).
      expect(mocks.getImagesByIds).toHaveBeenCalledWith({ blockToken: 'tok_abc', imageIds: [55] });
    });
    await vi.waitFor(() => {
      expect(mocks.saveDownload).toHaveBeenCalledWith(
        'https://image.civitai.com/edge/55.jpeg',
        '55.jpeg'
      );
    });
    await vi.waitFor(() => {
      const r = replies.last('SAVE_IMAGE_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_save_id', ok: true });
    });
    replies.stop();
  });

  test('SAVE_IMAGE id variant: a WITHHELD (hidden) image is NEVER downloaded (ok:false)', async () => {
    mocks.getImagesByIds.mockResolvedValue({ images: [{ imageId: 55, status: 'hidden' }] });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SAVE_IMAGE', { requestId: 'rq_save_hidden', imageId: 55 });

    await vi.waitFor(() => {
      const r = replies.last('SAVE_IMAGE_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({
        requestId: 'rq_save_hidden',
        ok: false,
        error: 'image is not available',
      });
    });
    // The gated read ran, but a hidden image is never handed to the downloader.
    expect(mocks.getImagesByIds).toHaveBeenCalled();
    expect(mocks.saveDownload).not.toHaveBeenCalled();
    replies.stop();
  });

  test('SAVE_IMAGE id variant: an UNRESOLVABLE id (omitted from the gated read) is refused', async () => {
    mocks.getImagesByIds.mockResolvedValue({ images: [] });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SAVE_IMAGE', { requestId: 'rq_save_gone', imageId: 999 });

    await vi.waitFor(() => {
      const r = replies.last('SAVE_IMAGE_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({
        requestId: 'rq_save_gone',
        ok: false,
        error: 'image is not available',
      });
    });
    expect(mocks.saveDownload).not.toHaveBeenCalled();
    replies.stop();
  });

  test('SAVE_IMAGE with BOTH url and imageId is an invalid request (ok:false, no download)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SAVE_IMAGE', {
      requestId: 'rq_save_both',
      url: 'https://image.civitai.com/x.jpeg',
      imageId: 5,
    });

    await vi.waitFor(() => {
      const r = replies.last('SAVE_IMAGE_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({
        requestId: 'rq_save_both',
        ok: false,
        error: 'invalid save-image request',
      });
    });
    expect(mocks.saveDownload).not.toHaveBeenCalled();
    expect(mocks.getImagesByIds).not.toHaveBeenCalled();
    replies.stop();
  });

  test(`F2: caps concurrent SAVE_IMAGE downloads — the (N+1)th gets busy (N=${SAVE_IMAGE_MAX_CONCURRENT})`, async () => {
    // Make the host-side download hang so the first N requests each hold an
    // in-flight slot; the (N+1)th must be refused `busy` BEFORE it fetches (so a
    // hostile block can't download-bomb the tab).
    mocks.saveDownload.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    for (let i = 0; i < SAVE_IMAGE_MAX_CONCURRENT; i++) {
      postFromBlock('SAVE_IMAGE', {
        requestId: `rq_c${i}`,
        url: 'https://image.civitai.com/xG/77/original.jpeg',
      });
    }
    postFromBlock('SAVE_IMAGE', {
      requestId: 'rq_overflow',
      url: 'https://image.civitai.com/xG/77/original.jpeg',
    });

    await vi.waitFor(() => {
      const r = replies.last('SAVE_IMAGE_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_overflow', ok: false, error: 'busy' });
    });
    // Only the N that acquired a slot reached the downloader; the overflow
    // short-circuited to busy BEFORE fetching a byte.
    expect(mocks.saveDownload).toHaveBeenCalledTimes(SAVE_IMAGE_MAX_CONCURRENT);
    replies.stop();
  });

  const PNG_BYTES = () =>
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]).buffer;

  test('SAVE_IMAGE bytes variant: content-classified, saved under the forced extension, ok', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();
    const bytes = PNG_BYTES();

    postFromBlock('SAVE_IMAGE', {
      requestId: 'rq_save_bytes',
      bytes,
      filename: 'healed.html',
    });

    await vi.waitFor(() => {
      const r = replies.last('SAVE_IMAGE_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_save_bytes', ok: true });
    });
    expect(mocks.saveBytesDownload).toHaveBeenCalledTimes(1);
    const [savedBytes, savedType, savedName] = mocks.saveBytesDownload.mock.calls[0];
    // toBe, not toEqual: vitest's toEqual treats any two ArrayBuffers as equal.
    expect(savedBytes).toBe(bytes);
    expect([savedType, savedName]).toEqual(['image/png', 'healed.png']);
    expect(mocks.saveDownload).not.toHaveBeenCalled();
    replies.stop();
  });

  test('SAVE_IMAGE bytes variant: an unclassifiable file is refused (ok:false, no download)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SAVE_IMAGE', {
      requestId: 'rq_save_bin',
      bytes: new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]).buffer,
      filename: 'setup.exe',
    });

    await vi.waitFor(() => {
      const r = replies.last('SAVE_IMAGE_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({
        requestId: 'rq_save_bin',
        ok: false,
        error: 'file type is not allowed',
      });
    });
    expect(mocks.saveBytesDownload).not.toHaveBeenCalled();
    replies.stop();
  });

  test('SAVE_IMAGE with BOTH bytes and url is an invalid request (no download of either)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SAVE_IMAGE', {
      requestId: 'rq_save_bytes_url',
      bytes: PNG_BYTES(),
      url: 'https://image.civitai.com/x.jpeg',
    });

    await vi.waitFor(() => {
      const r = replies.last('SAVE_IMAGE_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({
        requestId: 'rq_save_bytes_url',
        ok: false,
        error: 'invalid save-image request',
      });
    });
    expect(mocks.saveBytesDownload).not.toHaveBeenCalled();
    expect(mocks.saveDownload).not.toHaveBeenCalled();
    replies.stop();
  });

  test('SAVE_IMAGE bytes CROSS-FRAME: an ArrayBuffer posted from inside the opaque sandboxed iframe downloads; a Uint8Array is refused', async () => {
    // Every other bytes test dispatches a same-realm MessageEvent, so its ArrayBuffer is the host
    // realm's own and `instanceof ArrayBuffer` cannot fail. Here the block's script runs in the
    // iframe (an opaque, unverified sandbox) and posts with parent.postMessage, so the buffer is
    // structured-cloned across realms — the path a real block takes.
    renderWithProviders(<PageBlockHost {...baseProps} trustTier="unverified" />);
    await vi.waitFor(() => {
      const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
      if (!el.contentWindow) throw new Error('not mounted yet');
    });
    const iframeEl = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
    expect(iframeEl.getAttribute('sandbox')?.split(' ')).not.toContain('allow-same-origin');
    const cw = iframeEl.contentWindow;

    // The frame is cross-origin to us, so it reports what it receives by echoing to the parent.
    const echoes: Array<{ origin: string; data: { type?: string; payload?: unknown } }> = [];
    const onEcho = (e: MessageEvent) => {
      const d = e.data as { __xfEcho?: { type?: string; payload?: unknown } } | null;
      if (e.source === cw && d && d.__xfEcho) echoes.push({ origin: e.origin, data: d.__xfEcho });
    };
    window.addEventListener('message', onEcho);
    try {
      // Same contentWindow after the navigation, so the host's event.source pin still matches.
      iframeEl.srcdoc =
        `<script>
        var sent = false;
        function go() {
          if (sent) return;
          sent = true;
          var png = new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00,0x00,0x00,0x0d,0x49,0x48]);
          parent.postMessage({ type: 'SAVE_IMAGE', payload: { requestId: 'rq_xf_ab', bytes: png.buffer.slice(0), filename: 'cross#1.png' } }, '*');
          parent.postMessage({ type: 'SAVE_IMAGE', payload: { requestId: 'rq_xf_u8', bytes: new Uint8Array(png), filename: 'cross.png' } }, '*');
        }
        window.addEventListener('message', function (e) {
          if (e.source !== parent) return;
          parent.postMessage({ __xfEcho: e.data }, '*');
          if (e.data && e.data.type === 'BLOCK_INIT') go();
        });
        parent.postMessage({ type: 'BLOCK_READY', payload: {} }, '*');
        setTimeout(go, 300);
      </` + `script>`;

      await vi.waitFor(() => {
        const results = Object.fromEntries(
          echoes
            .filter((m) => m.data.type === 'SAVE_IMAGE_RESULT')
            .map((m) => {
              const p = m.data.payload as { requestId: string };
              return [p.requestId, m.data.payload];
            })
        );
        expect(results).toEqual({
          rq_xf_ab: { requestId: 'rq_xf_ab', ok: true },
          rq_xf_u8: { requestId: 'rq_xf_u8', ok: false, error: 'invalid save-image request' },
        });
      });
      // Positive control that the messages really came from the frame's realm: an opaque sandbox
      // posts with origin 'null', which no same-realm dispatch in this file produces.
      expect(new Set(echoes.map((m) => m.origin))).toEqual(new Set(['null']));

      expect(mocks.saveBytesDownload).toHaveBeenCalledTimes(1);
      const [savedBytes, savedType, savedName] = mocks.saveBytesDownload.mock.calls[0];
      expect(savedBytes).toBeInstanceOf(ArrayBuffer);
      expect(Array.from(new Uint8Array(savedBytes as ArrayBuffer))).toEqual([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48,
      ]);
      expect([savedType, savedName]).toEqual(['image/png', 'cross_1.png']);
    } finally {
      window.removeEventListener('message', onEcho);
    }
  });

  /** Every SAVE_IMAGE_RESULT payload received so far, keyed by requestId. */
  const saveResults = (replies: ReturnType<typeof listenForReply>) =>
    Object.fromEntries(
      replies.received
        .filter((m) => m.type === 'SAVE_IMAGE_RESULT')
        .map((m) => {
          const p = m.payload as { requestId: string; ok: boolean; error?: string };
          return [p.requestId, p.ok ? 'ok' : p.error];
        })
    );

  /** A PNG of `size` bytes: real signature, zero padding (the classifier only sniffs the head). */
  const pngOfSize = (size: number) => {
    const u8 = new Uint8Array(size);
    u8.set(new Uint8Array(PNG_BYTES()));
    return u8.buffer;
  };

  test(`SAVE_IMAGE bytes rate limit: the ${
    SAVE_BYTES_MAX_PER_WINDOW + 1
  }th save inside the window is busy, and saves are accepted again after it`, async () => {
    // Real time plus a movable offset, so nothing else in the host sees a frozen clock.
    let offset = 0;
    const realNow = Date.now.bind(Date);
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    try {
      renderWithProviders(<PageBlockHost {...baseProps} />);
      await driveToReady();
      const replies = listenForReply();

      for (let i = 0; i <= SAVE_BYTES_MAX_PER_WINDOW; i++) {
        postFromBlock('SAVE_IMAGE', { requestId: `rq_rate${i}`, bytes: PNG_BYTES() });
      }
      await vi.waitFor(() => {
        expect(saveResults(replies)).toEqual({
          rq_rate0: 'ok',
          rq_rate1: 'ok',
          rq_rate2: 'ok',
          rq_rate3: 'ok',
          rq_rate4: 'ok',
          rq_rate5: 'busy',
        });
      });
      expect(mocks.saveBytesDownload).toHaveBeenCalledTimes(SAVE_BYTES_MAX_PER_WINDOW);

      offset += SAVE_BYTES_WINDOW_MS;
      postFromBlock('SAVE_IMAGE', { requestId: 'rq_rate_after', bytes: PNG_BYTES() });
      await vi.waitFor(() => {
        expect(saveResults(replies).rq_rate_after).toBe('ok');
      });
      expect(mocks.saveBytesDownload).toHaveBeenCalledTimes(SAVE_BYTES_MAX_PER_WINDOW + 1);
      replies.stop();
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('SAVE_IMAGE bytes rate limit: a save that would push the window over 100 MB is busy', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();
    const MB = 1024 * 1024;

    // 40 + 40 = 80 MB fits; a third 40 MB would make 120 MB. Each is under the 50 MB per-file cap,
    // so only the window total can refuse the third.
    for (let i = 0; i < 3; i++) {
      postFromBlock('SAVE_IMAGE', { requestId: `rq_mb${i}`, bytes: pngOfSize(40 * MB) });
    }
    // …while a small one that still fits under 100 MB is accepted: it is the total, not a count.
    postFromBlock('SAVE_IMAGE', { requestId: 'rq_mb_small', bytes: pngOfSize(20 * MB) });

    await vi.waitFor(() => {
      expect(saveResults(replies)).toEqual({
        rq_mb0: 'ok',
        rq_mb1: 'ok',
        rq_mb2: 'busy',
        rq_mb_small: 'ok',
      });
    });
    expect(mocks.saveBytesDownload).toHaveBeenCalledTimes(3);
    replies.stop();
  });

  test('SAVE_IMAGE bytes is not held up by url saves filling the concurrency slots', async () => {
    mocks.saveDownload.mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    for (let i = 0; i < SAVE_IMAGE_MAX_CONCURRENT; i++) {
      postFromBlock('SAVE_IMAGE', {
        requestId: `rq_cb${i}`,
        url: 'https://image.civitai.com/xG/77/original.jpeg',
      });
    }
    postFromBlock('SAVE_IMAGE', { requestId: 'rq_bytes_free', bytes: PNG_BYTES() });

    await vi.waitFor(() => {
      expect(saveResults(replies).rq_bytes_free).toBe('ok');
    });
    expect(mocks.saveBytesDownload).toHaveBeenCalledTimes(1);
    replies.stop();
  });

  // ── Shared read-cache invalidation (write → own next read) ───────────────────
  //
  // civitai's QueryClient is `staleTime: Infinity` (~/utils/trpc), and every
  // shared READ here goes through `trpcUtils.apps.shared.*.fetch` — React Query
  // `fetchQuery`, which never refetches a non-stale entry. So without an explicit
  // invalidation a block's own write is invisible to its own next read for the
  // whole page lifetime. See sharedStorageInvalidation.ts.

  test('an invalidation FAILURE still reports the write as succeeded', async () => {
    // The helper swallows invalidation errors, and that property is
    // load-bearing rather than defensive: the write is already COMMITTED when
    // invalidation runs, so a throw escaping into the handler's try/catch would
    // send SHARED_APPEND_RESULT { error } for a row that exists. The block
    // would tell the user it failed, and a retry would duplicate it.
    //
    // Without this test the property had ZERO coverage — deleting the entire
    // try/catch left the whole suite green (found by adversarial audit).
    mocks.invalidate.mockRejectedValue(new Error('invalidation exploded'));
    mocks.append.mockResolvedValue({ key: '01COMMITTED' });

    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('SHARED_APPEND', { requestId: 'rq_inv_fail', value: { title: 'x' } });

    await vi.waitFor(() => {
      const r = replies.last('SHARED_APPEND_RESULT');
      if (!r) throw new Error('no reply yet');
      // Success shape, NOT an error shape.
      expect(r.payload).toEqual({ requestId: 'rq_inv_fail', key: '01COMMITTED' });
    });
    replies.stop();
  });
});
