import { afterEach, describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { IframeHost } from '~/components/AppBlocks/IframeHost';
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';
import type { BlockInstall, ModelSlotContext } from '~/components/AppBlocks/types';
import { BrowsingLevelProvider } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { installTrpcWire, renderWithTrpcWire } from '../../../test/trpcWireHarness';

/**
 * Same-origin app frames, through the REAL page host under the real AppProvider and
 * FeatureFlagsProvider (no module mocks; the network is the tRPC wire fake).
 *
 * The original symptom: an unverified app's frame ran at an opaque origin, so
 * `new SharedWorker(...)` (and localStorage, IndexedDB, cookies) threw with origin
 * 'null'. This file cannot load an `https://<slug>.<apps domain>` frame (the test server
 * is plain http on localhost), so it proves the two halves separately and joins them on
 * the SAME string:
 *   1. the host renders `allow-same-origin` on an unverified frame on its app host when
 *      the flag is on (and not when it is off);
 *   2. a real Chromium frame carrying EXACTLY the sandbox string the host rendered can
 *      construct a SharedWorker and use localStorage, and one carrying the flag-off string
 *      cannot (SecurityError, the reported failure).
 */

const APPS_ROOT = 'apps-root.example';
const APP_SRC = `https://my-app.${APPS_ROOT}/`;

let wire: ReturnType<typeof installTrpcWire> | undefined;
afterEach(() => {
  wire?.restore();
  wire = undefined;
  document.querySelectorAll('iframe[data-probe]').forEach((f) => f.remove());
});

const props = {
  appBlockId: 'apb_same_origin_1',
  blockId: 'my-app',
  appId: 'app_same_origin_1',
  blockInstanceId: 'page_apb_same_origin_1',
  appName: 'My App',
  iframeSrc: APP_SRC,
  surface: 'page-run' as const,
  bootSkeleton: false,
  sandbox: 'allow-scripts allow-forms',
  trustTier: 'unverified' as const,
  slug: 'my-app',
  token: 'tok_same_origin',
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  declaredScopes: [] as string[],
  missingScopes: [] as string[],
  needsConsent: false,
  tokenError: false,
  viewer: { id: 42, username: 'tester' },
  theme: 'light' as const,
};

async function renderedSandbox(opts: {
  flagOn: boolean;
  reviewMode?: boolean;
  appFrameDomains?: string[];
}): Promise<string> {
  wire = installTrpcWire({});
  const screen = await renderWithTrpcWire(
    <PageBlockHost
      {...props}
      {...(opts.reviewMode ? { reviewMode: true, surface: 'review-preview' as const } : {})}
    />,
    {
      viewer: { id: 42, username: 'tester' },
      flags: opts.flagOn ? { appBlocksSameOriginFrames: true } : {},
      appFrameDomains: 'appFrameDomains' in opts ? opts.appFrameDomains : [APPS_ROOT],
    }
  );
  const iframe = page.getByTestId('app-page-iframe');
  await expect.element(iframe).toBeInTheDocument();
  const value = (iframe.element() as HTMLIFrameElement).getAttribute('sandbox') ?? '';
  await screen.unmount();
  wire.restore();
  wire = undefined;
  return value;
}

type ProbeResult = { sharedWorker: string; localStorage: string };

/** Load a srcdoc frame with `sandbox` and report what its script could do. */
async function probeFrame(sandbox: string): Promise<ProbeResult> {
  const frame = document.createElement('iframe');
  frame.dataset.probe = 'same-origin';
  frame.setAttribute('sandbox', sandbox);
  const result = new Promise<ProbeResult>((resolve) => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow) return;
      const d = e.data as { probe?: string } & ProbeResult;
      if (d?.probe !== 'same-origin') return;
      window.removeEventListener('message', onMessage);
      resolve({ sharedWorker: d.sharedWorker, localStorage: d.localStorage });
    };
    window.addEventListener('message', onMessage);
  });
  frame.srcdoc = `<script>
    const out = { probe: 'same-origin', sharedWorker: 'pending', localStorage: 'pending' };
    const send = () => parent.postMessage(out, '*');
    try { localStorage.setItem('k', 'v'); out.localStorage = localStorage.getItem('k') === 'v' ? 'ok' : 'mismatch'; }
    catch (e) { out.localStorage = 'threw:' + (e && e.name); }
    try {
      const url = URL.createObjectURL(new Blob(['onconnect = (e) => e.ports[0].postMessage("pong");'], { type: 'text/javascript' }));
      const w = new SharedWorker(url);
      w.port.onmessage = (e) => { out.sharedWorker = e.data === 'pong' ? 'ok' : 'bad-reply'; send(); };
      w.onerror = () => { out.sharedWorker = 'worker-error'; send(); };
      w.port.start();
    } catch (e) { out.sharedWorker = 'threw:' + (e && e.name); send(); }
  </script>`;
  document.body.appendChild(frame);
  return result;
}

describe('PageBlockHost: unverified frame on its app host', () => {
  test('REGRESSION: flag on → allow-same-origin, and that exact sandbox runs a SharedWorker', async () => {
    const on = await renderedSandbox({ flagOn: true });
    expect(on.split(/\s+/)).toContain('allow-same-origin');
    expect(await probeFrame(on)).toEqual({ sharedWorker: 'ok', localStorage: 'ok' });
  });

  test('CONTROL: flag off → opaque, and that exact sandbox reproduces the reported SecurityError', async () => {
    const off = await renderedSandbox({ flagOn: false });
    expect(off.split(/\s+/)).not.toContain('allow-same-origin');
    expect(off.split(/\s+/)).toContain('allow-scripts');
    const probe = await probeFrame(off);
    expect(probe.sharedWorker).toBe('threw:SecurityError');
    expect(probe.localStorage).toBe('threw:SecurityError');
  });

  test('INVARIANT: a review mount stays opaque with the flag on', async () => {
    const review = await renderedSandbox({ flagOn: true, reviewMode: true });
    expect(review.split(/\s+/)).not.toContain('allow-same-origin');
  });

  test('INVARIANT: with no frame roots from the server, the flag alone grants nothing', async () => {
    const none = await renderedSandbox({ flagOn: true, appFrameDomains: undefined });
    expect(none.split(/\s+/)).not.toContain('allow-same-origin');
  });
});

const slotInstall: BlockInstall = {
  blockInstanceId: 'bi_same_origin_slot',
  blockId: 'my-app',
  appId: 'app_same_origin_1',
  appBlockId: 'apb_same_origin_slot',
  manifest: {
    name: 'My App',
    scopes: [],
    iframe: {
      src: APP_SRC,
      minHeight: 200,
      maxHeight: 800,
      resizable: true,
      sandbox: 'allow-scripts allow-forms',
    },
  },
  publisherSettings: {},
  enabled: true,
  renderMode: 'iframe',
  trustTier: 'unverified',
};

const slotContext: ModelSlotContext = {
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

async function slotSandbox(flagOn: boolean): Promise<string> {
  wire = installTrpcWire({});
  const screen = await renderWithTrpcWire(
    <BrowsingLevelProvider>
      <IframeHost
        install={slotInstall}
        context={slotContext}
        token="tok_same_origin"
        expiresAt={new Date(Date.now() + 15 * 60_000).toISOString()}
      />
    </BrowsingLevelProvider>,
    {
      viewer: { id: 42, username: 'tester' },
      flags: flagOn ? { appBlocksSameOriginFrames: true } : {},
      appFrameDomains: [APPS_ROOT],
    }
  );
  const iframe = page.getByTestId('block-iframe');
  await expect.element(iframe).toBeInTheDocument();
  const value = (iframe.element() as HTMLIFrameElement).getAttribute('sandbox') ?? '';
  await screen.unmount();
  wire.restore();
  wire = undefined;
  return value;
}

describe('IframeHost (model slot): unverified frame on its app host', () => {
  test('REGRESSION: flag on → allow-same-origin on the slot frame too', async () => {
    expect((await slotSandbox(true)).split(/\s+/)).toContain('allow-same-origin');
  });

  test('CONTROL: flag off → the slot frame stays opaque', async () => {
    const off = (await slotSandbox(false)).split(/\s+/);
    expect(off).toContain('allow-scripts');
    expect(off).not.toContain('allow-same-origin');
  });
});
