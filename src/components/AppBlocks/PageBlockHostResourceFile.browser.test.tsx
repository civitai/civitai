import JSZip from 'jszip';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { useDialogStore } from '~/components/Dialog/dialogStore';
import {
  RESOURCE_FILE_CAPS,
  RESOURCE_FILE_MAX_CONCURRENT,
} from '~/components/AppBlocks/resourceFileParse';
import type * as TrpcMod from '~/utils/trpc';
import type * as ResourceFileParseMod from '~/components/AppBlocks/resourceFileParse';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { expectReplyKeys } from '../../../test/expectReplyKeys';
import { makeInertSubRouter, makeTrpcProxy } from '../../../test/trpcProxyStub';

/**
 * GET_RESOURCE_FILE on the REAL PageBlockHost (civitai-app-starters#664). The resolve
 * mutation and `fetch` are stubbed; jszip, the caps and the format detector run for real.
 */

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), fetch: vi.fn() }));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

// Short enough for a test to wait out, far longer than any other case here takes.
const { TEST_DEADLINE_MS } = vi.hoisted(() => ({ TEST_DEADLINE_MS: 3000 }));
vi.mock('~/components/AppBlocks/resourceFileParse', async (importOriginal) => ({
  ...(await importOriginal<typeof ResourceFileParseMod>()),
  RESOURCE_FILE_DEADLINE_MS: TEST_DEADLINE_MS,
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  setTrpcBatchingEnabled: vi.fn(),
  trpc: makeTrpcProxy({
    'generation.resolveResourceFile': { useMutation: () => ({ mutateAsync: mocks.resolve }) },
    'apps.shared': makeInertSubRouter(),
    'apps.storage': makeInertSubRouter(),
  }),
}));

// eslint-disable-next-line import/first
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';

const API_GRAPH = {
  '3': { class_type: 'KSampler', inputs: { seed: 1 } },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'x.safetensors' } },
};
const UI_GRAPH = { last_node_id: 2, nodes: [{ id: 1 }, { id: 2 }], links: [] };

const SIGNED_URL = 'https://files.example/w.bin?sig=topsecret';

function meta(fileName: string, fileId = 77) {
  return {
    modelId: 55,
    modelVersionId: 100,
    fileId,
    fileName,
    modelName: 'Cool Workflow',
    versionName: 'v1.0',
    creatorUsername: 'creator',
  };
}

function resolvesTo(fileName: string, bytes: Uint8Array, sizeBytes = bytes.byteLength) {
  mocks.resolve.mockResolvedValue({ signedUrl: SIGNED_URL, sizeBytes, meta: meta(fileName) });
  mocks.fetch.mockImplementation(async (url: unknown) =>
    String(url) === SIGNED_URL
      ? ({ ok: true, arrayBuffer: async () => bytes.slice().buffer } as unknown as Response)
      : ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response)
  );
}

const utf8 = (s: string) => new TextEncoder().encode(s);

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
    last: (type: string) => [...received].reverse().find((m) => m.type === type),
    stop: () => cw.removeEventListener('message', handler),
  };
}

const baseProps = {
  appBlockId: 'apb_test',
  blockId: 'workflow-app',
  appId: 'app_test',
  blockInstanceId: 'page_apb_test',
  appName: 'Workflow Loader',
  iframeSrc: `${window.location.origin}/`,
  surface: 'page-run' as const,
  bootSkeleton: false,
  sandbox: 'allow-scripts',
  trustTier: 'internal' as const,
  slug: 'workflow-app',
  token: 'tok_abc',
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  declaredScopes: [] as string[],
  missingScopes: [] as string[],
  needsConsent: false,
  tokenError: false,
  viewer: { id: 42, username: 'tester' },
  theme: 'light' as const,
};

async function mountReady(extra: Record<string, unknown> = {}) {
  renderWithProviders(<PageBlockHost {...baseProps} {...extra} />);
  await vi.waitFor(() => {
    const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
    if (!el.contentWindow) throw new Error('not mounted yet');
  });
  await vi.waitFor(() => {
    postFromBlock('BLOCK_READY', {});
    const el = page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;
    if (el.getAttribute('data-block-ready') !== 'true') throw new Error('not ready yet');
  });
  return listenForReply();
}

type Reply = {
  requestId: string;
  error?: string;
  file?: {
    meta: Record<string, unknown>;
    entries: Array<{ path: string; format: string; graph: unknown }>;
    truncated: boolean;
  };
};

async function request(
  replies: ReturnType<typeof listenForReply>,
  payload: Record<string, unknown>,
  timeout = 5000
): Promise<Reply> {
  postFromBlock('GET_RESOURCE_FILE', payload);
  let reply: Reply | undefined;
  await vi.waitFor(
    () => {
      const r = replies.last('RESOURCE_FILE_RESULT');
      const p = r?.payload as Reply | undefined;
      if (!p || p.requestId !== payload.requestId) throw new Error('no reply yet');
      reply = p;
    },
    { timeout }
  );
  return reply!;
}

const fetchedSignedUrl = () => mocks.fetch.mock.calls.some((c) => String(c[0]) === SIGNED_URL);

describe('PageBlockHost GET_RESOURCE_FILE bridge', () => {
  beforeEach(() => {
    mocks.resolve.mockReset();
    mocks.fetch.mockReset();
    mocks.fetch.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response);
    vi.stubGlobal('fetch', mocks.fetch);
    useDialogStore.getState().closeAll();
  });

  test('a .json file round-trips as one ui entry, with meta and no credential', async () => {
    resolvesTo('graph.json', utf8(JSON.stringify(UI_GRAPH)));
    const replies = await mountReady();

    const reply = await request(replies, { requestId: 'rq_json', modelVersionId: 100 });

    expect(mocks.resolve).toHaveBeenCalledWith({ modelVersionId: 100 });
    expectReplyKeys('GET_RESOURCE_FILE', 'success', ['file'], reply);
    expect(reply.file).toEqual({
      meta: meta('graph.json'),
      entries: [{ path: 'graph.json', format: 'ui', graph: UI_GRAPH }],
      truncated: false,
    });
    const serialized = JSON.stringify(reply);
    expect(serialized).not.toContain('files.example');
    expect(serialized).not.toContain('topsecret');
    replies.stop();
  });

  test('a .zip returns each JSON entry with its format and skips everything else', async () => {
    const zip = new JSZip();
    zip.file('api.json', JSON.stringify(API_GRAPH));
    zip.file('nested/ui.json', JSON.stringify(UI_GRAPH));
    zip.file('notes.json', JSON.stringify({ hello: 'world' }));
    zip.file('preview.png', 'not-an-image');
    zip.file('__MACOSX/._api.json', 'resource fork');
    resolvesTo('bundle.zip', await zip.generateAsync({ type: 'uint8array' }));
    const replies = await mountReady();

    const reply = await request(replies, { requestId: 'rq_zip', modelVersionId: 100, fileId: 77 });

    expect(mocks.resolve).toHaveBeenCalledWith({ modelVersionId: 100, fileId: 77 });
    expect(reply.file!.truncated).toBe(false);
    expect(reply.file!.entries.map((e) => [e.path, e.format])).toEqual([
      ['api.json', 'api'],
      ['nested/ui.json', 'ui'],
      ['notes.json', 'unknown'],
    ]);
    expect(reply.file!.entries[0].graph).toEqual(API_GRAPH);
    replies.stop();
  });

  test(`a zip with more than ${RESOURCE_FILE_CAPS.maxEntries} JSON entries is truncated`, async () => {
    const zip = new JSZip();
    const count = RESOURCE_FILE_CAPS.maxEntries + 3;
    for (let i = 0; i < count; i++) zip.file(`w${String(i).padStart(2, '0')}.json`, `{"i":${i}}`);
    resolvesTo('many.zip', await zip.generateAsync({ type: 'uint8array' }));
    const replies = await mountReady();

    const reply = await request(replies, { requestId: 'rq_many', modelVersionId: 100 });

    expect(reply.file!.entries).toHaveLength(RESOURCE_FILE_CAPS.maxEntries);
    expect(reply.file!.truncated).toBe(true);
    replies.stop();
  });

  test('too large before download: an advertised size over 32 MB is refused without fetching', async () => {
    resolvesTo('huge.zip', new Uint8Array(1), 33 * 1024 * 1024);
    const replies = await mountReady();

    const reply = await request(replies, { requestId: 'rq_big', modelVersionId: 100 });

    expect(reply).toEqual({ requestId: 'rq_big', error: 'too-large' });
    expectReplyKeys('GET_RESOURCE_FILE', 'error', ['error'], reply);
    expect(fetchedSignedUrl()).toBe(false);
    replies.stop();
  });

  test('too large after download: a .json over the 4 MB entry cap is refused', async () => {
    const pad = 'x'.repeat(RESOURCE_FILE_CAPS.perEntryBytes + 10);
    // Advertised small, so only the post-download cap can catch it.
    resolvesTo('big.json', utf8(JSON.stringify({ nodes: [], pad })), 1024);
    const replies = await mountReady();

    const reply = await request(replies, { requestId: 'rq_big2', modelVersionId: 100 });

    expect(fetchedSignedUrl()).toBe(true);
    expect(reply).toEqual({ requestId: 'rq_big2', error: 'too-large' });
    replies.stop();
  });

  test('an under-declared body is cut off once it passes 32 MB, not buffered whole', async () => {
    // The advertised size comes from the uploader. This body never ends, so a host
    // that buffers it before checking never replies.
    const chunk = new Uint8Array(1024 * 1024);
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
    });
    mocks.resolve.mockResolvedValue({
      signedUrl: SIGNED_URL,
      sizeBytes: 1024,
      meta: meta('w.zip'),
    });
    mocks.fetch.mockImplementation(async (url: unknown) =>
      String(url) === SIGNED_URL
        ? new Response(body)
        : ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response)
    );
    const replies = await mountReady();

    const reply = await request(replies, { requestId: 'rq_stream', modelVersionId: 100 });

    expect(reply).toEqual({ requestId: 'rq_stream', error: 'too-large' });
    expect(pulled).toBeLessThan(40);
    replies.stop();
  });

  test('a file that is not JSON is parse-failed', async () => {
    resolvesTo('graph.json', utf8('{ not json'));
    const replies = await mountReady();

    const reply = await request(replies, { requestId: 'rq_pf', modelVersionId: 100 });

    expect(reply).toEqual({ requestId: 'rq_pf', error: 'parse-failed' });
    replies.stop();
  });

  test.each([
    ['UNAUTHORIZED', 'unauthorized', 'signed out'],
    ['TOO_MANY_REQUESTS', 'rate-limited', 'rate limited'],
    ['NOT_FOUND', 'not-found', 'refused by the resolver'],
    ['FORBIDDEN', 'forbidden', 'over the maturity ceiling'],
  ])('a %s from the resolver replies %s (%s)', async (code, expected) => {
    mocks.resolve.mockRejectedValue({ data: { code } });
    const replies = await mountReady();

    const reply = await request(replies, { requestId: `rq_${code}`, modelVersionId: 100 });

    expect(reply).toEqual({ requestId: `rq_${code}`, error: expected });
    expect(fetchedSignedUrl()).toBe(false);
    replies.stop();
  });

  test(`the request past ${RESOURCE_FILE_MAX_CONCURRENT} in flight gets busy, and slots free up`, async () => {
    const pending: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
    mocks.resolve.mockImplementation(
      () => new Promise((resolve, reject) => pending.push({ resolve, reject }))
    );
    const replies = await mountReady();

    for (let i = 0; i < RESOURCE_FILE_MAX_CONCURRENT; i++) {
      postFromBlock('GET_RESOURCE_FILE', { requestId: `c${i}`, modelVersionId: 100 });
    }
    const reply = await request(replies, { requestId: 'overflow', modelVersionId: 100 });

    expect(reply).toEqual({ requestId: 'overflow', error: 'busy' });
    expect(mocks.resolve).toHaveBeenCalledTimes(RESOURCE_FILE_MAX_CONCURRENT);

    // Settle every held request, failures included; each must give its slot back.
    resolvesTo('graph.json', utf8(JSON.stringify(UI_GRAPH)));
    for (const p of pending) p.reject({ data: { code: 'NOT_FOUND' } });
    await vi.waitFor(() => {
      const last = replies.last('RESOURCE_FILE_RESULT')?.payload as Reply | undefined;
      expect(last?.requestId).toBe(`c${RESOURCE_FILE_MAX_CONCURRENT - 1}`);
    });

    const after = await request(replies, { requestId: 'after', modelVersionId: 100 });
    expect(after.file?.entries).toHaveLength(1);
    replies.stop();
  });

  test('requests that outlive the deadline reply parse-failed and free their slots', async () => {
    mocks.resolve.mockReturnValue(new Promise(() => undefined));
    const replies = await mountReady();

    for (let i = 0; i < RESOURCE_FILE_MAX_CONCURRENT - 1; i++) {
      postFromBlock('GET_RESOURCE_FILE', { requestId: `h${i}`, modelVersionId: 100 });
    }
    const started = Date.now();
    const timedOut = await request(
      replies,
      { requestId: `h${RESOURCE_FILE_MAX_CONCURRENT - 1}`, modelVersionId: 100 },
      TEST_DEADLINE_MS + 3000
    );
    expect(timedOut).toEqual({
      requestId: `h${RESOURCE_FILE_MAX_CONCURRENT - 1}`,
      error: 'parse-failed',
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(TEST_DEADLINE_MS - 100);

    // Every abandoned request gave its slot back, so a retry is served, not `busy`.
    resolvesTo('graph.json', utf8(JSON.stringify(UI_GRAPH)));
    const retry = await request(replies, { requestId: 'retry', modelVersionId: 100 });
    expect(retry.file?.entries).toHaveLength(1);
    replies.stop();
  });

  test('fileId sent as undefined is treated as no fileId', async () => {
    resolvesTo('graph.json', utf8(JSON.stringify(UI_GRAPH)));
    const replies = await mountReady();

    const reply = await request(replies, {
      requestId: 'rq_undef',
      modelVersionId: 100,
      fileId: undefined,
    });

    expect(mocks.resolve).toHaveBeenCalledWith({ modelVersionId: 100 });
    expect(reply.file?.entries).toHaveLength(1);
    replies.stop();
  });

  test('review preview refuses with forbidden before resolving anything', async () => {
    const replies = await mountReady({ reviewMode: true, onConsentGranted: vi.fn() });

    const reply = await request(replies, { requestId: 'rq_review', modelVersionId: 100 });

    expect(reply).toEqual({ requestId: 'rq_review', error: 'forbidden' });
    expect(mocks.resolve).not.toHaveBeenCalled();
    replies.stop();
  });

  test('a request with no requestId, or a bad fileId, is dropped', async () => {
    const replies = await mountReady();

    postFromBlock('GET_RESOURCE_FILE', { modelVersionId: 100 });
    postFromBlock('GET_RESOURCE_FILE', { requestId: 'bad', modelVersionId: 100, fileId: -1 });

    await new Promise((r) => setTimeout(r, 150));
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(replies.last('RESOURCE_FILE_RESULT')).toBeUndefined();
    replies.stop();
  });
});
