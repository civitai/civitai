import JSZip from 'jszip';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { useDialogStore } from '~/components/Dialog/dialogStore';
import { WILDCARD_MAX_CONCURRENT } from '~/components/AppBlocks/wildcardPackParse';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * W13 wildcard-pack import bridge (page surface).
 *
 * A full-page App Block posts GET_WILDCARD_PACK{ requestId, modelVersionId }; the
 * host resolves the gated signed URL via the SESSION-authed
 * `generation.resolveWildcardPack` mutation (NOT a block token), fetches +
 * unzips + parses the pack CLIENT-SIDE (as the user), and posts back
 * WILDCARD_PACK_RESULT{ requestId, pack } — or an `error` discriminant. These
 * tests mount the REAL PageBlockHost and drive the actual postMessage bridge:
 *   - the happy round-trip (real zip → parsed lists + meta + maturity),
 *   - the 32 MB pre-download reject (fetch never fires),
 *   - the NOT_FOUND / FORBIDDEN / parse-failed error discriminants,
 *   - a fetch abort → parse-failed (cancel),
 *   - a dropped (no requestId) request.
 *
 * `trpc` is mocked (`vi.mock('~/utils/trpc')`) and `fetch` is stubbed so the
 * test is network-free; jszip runs for REAL in the browser env.
 */

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('~/utils/trpc', () => ({
  setTrpcBatchingEnabled: vi.fn(),
  trpc: {
    generation: {
      resolveWildcardPack: { useMutation: () => ({ mutateAsync: mocks.resolve }) },
    },
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
    },
    apps: {
      shared: {
        append: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        update: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        vote: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        unvote: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        withdraw: { useMutation: () => ({ mutateAsync: vi.fn() }) },
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
        storage: { get: { fetch: vi.fn() }, list: { fetch: vi.fn() }, getQuota: { fetch: vi.fn() } },
      },
    }),
  },
}));

// eslint-disable-next-line import/first
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';

let zipBytes: Uint8Array;
beforeAll(async () => {
  const zip = new JSZip();
  zip.file('colors.txt', '# palette\nred\nblue\nred\n#ffffff');
  zip.file('nouns.yaml', 'animals:\n  - cat\n  - dog');
  zip.file('preview.png', 'not-a-real-image');
  zipBytes = await zip.generateAsync({ type: 'uint8array' });
});

function postFromBlock(type: string, payload?: unknown) {
  const iframeEl = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
  const cw = iframeEl.contentWindow;
  if (!cw) throw new Error('iframe contentWindow missing');
  window.dispatchEvent(
    new MessageEvent('message', { data: { type, payload }, origin: window.location.origin, source: cw })
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

const SAME_ORIGIN_SRC = `${window.location.origin}/`;
const baseProps = {
  appBlockId: 'apb_test',
  blockId: 'wildcard-app',
  appId: 'app_test',
  blockInstanceId: 'page_apb_test',
  appName: 'Wildcard Importer',
  iframeSrc: SAME_ORIGIN_SRC,
  sandbox: 'allow-scripts',
  trustTier: 'internal' as const,
  slug: 'wildcard-app',
  token: 'tok_abc',
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  declaredScopes: ['apps:storage:read'],
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

const RESOLVED_META = {
  modelId: 55,
  modelVersionId: 100,
  modelName: 'Cool Wildcards',
  versionName: 'v1.0',
  creatorUsername: 'creator',
};
const RESOLVED_MATURITY = { browsingLevel: 3, sfwOnly: true };

// Did the host fetch the pack's SIGNED URL? (The fire-and-forget block-render
// beacon at BLOCK_READY also goes through the stubbed fetch — to a DIFFERENT
// URL — so "was fetch called at all" is the wrong question; we ask whether the
// signed URL specifically was requested.)
function fetchedSignedUrl(url: string): boolean {
  return mocks.fetch.mock.calls.some((c) => String(c[0]).includes(url));
}

describe('PageBlockHost wildcard-pack bridge (W13)', () => {
  beforeEach(() => {
    mocks.resolve.mockReset();
    mocks.fetch.mockReset();
    // Harmless default so the BLOCK_READY analytics beacon (which also uses the
    // stubbed global fetch) gets a real Promise Response and never crashes the
    // test; each test overrides for the pack fetch.
    mocks.fetch.mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response);
    vi.stubGlobal('fetch', mocks.fetch);
    useDialogStore.getState().closeAll();
  });

  test('GET_WILDCARD_PACK round-trip: resolves, fetches, unzips, posts parsed lists + meta + maturity', async () => {
    mocks.resolve.mockResolvedValue({
      signedUrl: 'https://b2.example/pack.zip?sig=1',
      sizeBytes: zipBytes.byteLength,
      meta: RESOLVED_META,
      maturity: RESOLVED_MATURITY,
    });
    mocks.fetch.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => zipBytes.buffer.slice(0),
    } as unknown as Response);

    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('GET_WILDCARD_PACK', { requestId: 'rq_wp', modelVersionId: 100 });

    await vi.waitFor(() => {
      expect(mocks.resolve).toHaveBeenCalledWith({ modelVersionId: 100 });
    });
    await vi.waitFor(() => {
      const r = replies.last('WILDCARD_PACK_RESULT');
      if (!r) throw new Error('no reply yet');
      const payload = r.payload as { requestId: string; pack?: any; error?: string };
      expect(payload.requestId).toBe('rq_wp');
      expect(payload.error).toBeUndefined();
      expect(payload.pack.lists).toEqual({ colors: ['red', 'blue', '#ffffff'], animals: ['cat', 'dog'] });
      expect(payload.pack.modelVersionId).toBe(100);
      expect(payload.pack.creatorUsername).toBe('creator');
      expect(payload.pack.maturity).toEqual(RESOLVED_MATURITY);
      expect(payload.pack.truncated).toBe(false);
      expect(payload.pack.truncatedLists).toEqual([]);

      // SECURITY REGRESSION GUARD (the highest-value property of this design):
      // the signed download URL + fileId are a bearer credential that must NEVER
      // reach the untrusted iframe. The host posts ONLY {...meta, lists, ...} —
      // a `...resolved` typo (instead of `...resolved.meta`) would leak the URL
      // and otherwise pass silently. Pin it: no credential field, and the signed
      // URL's host/query-token appear NOWHERE in the serialized message.
      expect(payload.pack.signedUrl).toBeUndefined();
      expect((payload.pack as { fileId?: unknown }).fileId).toBeUndefined();
      expect((payload.pack as { url?: unknown }).url).toBeUndefined();
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain('signedUrl');
      expect(serialized).not.toContain('fileId');
      expect(serialized).not.toContain('b2.example'); // the delivery-host
      expect(serialized).not.toContain('sig=1'); // the signed-URL credential token
    });
    replies.stop();
  });

  test('32 MB pre-download cap: an oversized sizeBytes replies too-large WITHOUT fetching', async () => {
    mocks.resolve.mockResolvedValue({
      signedUrl: 'https://b2.example/huge.zip',
      sizeBytes: 33 * 1024 * 1024, // > 32 MB
      meta: RESOLVED_META,
      maturity: RESOLVED_MATURITY,
    });

    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('GET_WILDCARD_PACK', { requestId: 'rq_big', modelVersionId: 100 });

    await vi.waitFor(() => {
      const r = replies.last('WILDCARD_PACK_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_big', error: 'too-large' });
    });
    expect(fetchedSignedUrl('huge.zip')).toBe(false);
    replies.stop();
  });

  test('NOT_FOUND from the resolve proc → error: not-found', async () => {
    mocks.resolve.mockRejectedValue({ data: { code: 'NOT_FOUND' } });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('GET_WILDCARD_PACK', { requestId: 'rq_nf', modelVersionId: 100 });

    await vi.waitFor(() => {
      const r = replies.last('WILDCARD_PACK_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_nf', error: 'not-found' });
    });
    expect(fetchedSignedUrl('b2.example')).toBe(false);
    replies.stop();
  });

  test('FORBIDDEN (maturity) from the resolve proc → error: forbidden', async () => {
    mocks.resolve.mockRejectedValue({ data: { code: 'FORBIDDEN' } });
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('GET_WILDCARD_PACK', { requestId: 'rq_fb', modelVersionId: 100 });

    await vi.waitFor(() => {
      const r = replies.last('WILDCARD_PACK_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_fb', error: 'forbidden' });
    });
    replies.stop();
  });

  test('a non-zip payload → error: parse-failed', async () => {
    mocks.resolve.mockResolvedValue({
      signedUrl: 'https://b2.example/pack.zip',
      sizeBytes: 100,
      meta: RESOLVED_META,
      maturity: RESOLVED_MATURITY,
    });
    mocks.fetch.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4, 5]).buffer,
    } as unknown as Response);

    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('GET_WILDCARD_PACK', { requestId: 'rq_pf', modelVersionId: 100 });

    await vi.waitFor(() => {
      const r = replies.last('WILDCARD_PACK_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_pf', error: 'parse-failed' });
    });
    replies.stop();
  });

  test('a fetch abort (timeout/cancel) → error: parse-failed', async () => {
    mocks.resolve.mockResolvedValue({
      signedUrl: 'https://b2.example/pack.zip',
      sizeBytes: 100,
      meta: RESOLVED_META,
      maturity: RESOLVED_MATURITY,
    });
    mocks.fetch.mockImplementation(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });

    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('GET_WILDCARD_PACK', { requestId: 'rq_ab', modelVersionId: 100 });

    await vi.waitFor(() => {
      const r = replies.last('WILDCARD_PACK_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'rq_ab', error: 'parse-failed' });
    });
    replies.stop();
  });

  test(`caps concurrent in-flight parses: the (N+1)th request gets busy (N=${WILDCARD_MAX_CONCURRENT})`, async () => {
    // Make the resolve proc hang so the first N requests occupy every in-flight
    // slot (each awaits resolve forever), then the (N+1)th must be rejected busy.
    mocks.resolve.mockReturnValue(new Promise(() => {}));

    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    // Saturate the N slots, then one more.
    for (let i = 0; i < WILDCARD_MAX_CONCURRENT; i++) {
      postFromBlock('GET_WILDCARD_PACK', { requestId: `c${i}`, modelVersionId: 100 });
    }
    postFromBlock('GET_WILDCARD_PACK', { requestId: 'overflow', modelVersionId: 100 });

    await vi.waitFor(() => {
      const r = replies.last('WILDCARD_PACK_RESULT');
      if (!r) throw new Error('no reply yet');
      expect(r.payload).toEqual({ requestId: 'overflow', error: 'busy' });
    });
    // Only the N that acquired a slot called the resolve proc; the overflow
    // short-circuited to busy BEFORE calling it (so memory stays bounded).
    expect(mocks.resolve).toHaveBeenCalledTimes(WILDCARD_MAX_CONCURRENT);
    replies.stop();
  });

  test('a GET_WILDCARD_PACK with NO requestId is dropped (no proc call, no reply)', async () => {
    renderWithProviders(<PageBlockHost {...baseProps} />);
    await driveToReady();
    const replies = listenForReply();

    postFromBlock('GET_WILDCARD_PACK', { modelVersionId: 100 }); // missing requestId

    await new Promise((r) => setTimeout(r, 150));
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(replies.last('WILDCARD_PACK_RESULT')).toBeUndefined();
    replies.stop();
  });
});
