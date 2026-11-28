import { afterEach, describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';
import type { BlockHostSurface } from '~/components/AppBlocks/blockInitFragmentGate';
import { installTrpcWire, renderWithTrpcWire } from '../../../test/trpcWireHarness';

/**
 * The versioned frame path, through the REAL page host under the real AppProvider and
 * FeatureFlagsProvider (no module mocks; the network is the tRPC wire fake).
 *
 * With the viewer's `appBlocksVersionedFramePath` flag on and the app's current version
 * sha known, a published page app's frame loads `https://<slug>.<apps root>/v/<sha>/`
 * instead of the root, so a service worker installed by one version (scope at most its
 * own `/v/<sha>/`) cannot control the next version's documents. Only the PATH moves:
 * the origin, and everything keyed on it (here: the `allow-same-origin` grant that
 * `mayGrantSameOrigin` derives from the frame host), is unchanged.
 */

const APPS_ROOT = 'apps-root.example';
const APP_SRC = `https://my-app.${APPS_ROOT}/`;
// Distinct from every other hex in this file, and has letters (a case-folding mutant
// cannot pass with it).
const SHA = 'c0ffee1234567890abcdef0123456789abcdef01';

let wire: ReturnType<typeof installTrpcWire> | undefined;
afterEach(() => {
  wire?.restore();
  wire = undefined;
});

const props = {
  appBlockId: 'apb_versioned_1',
  blockId: 'my-app',
  appId: 'app_versioned_1',
  blockInstanceId: 'page_apb_versioned_1',
  appName: 'My App',
  iframeSrc: APP_SRC,
  bootSkeleton: false,
  sandbox: 'allow-scripts allow-forms',
  trustTier: 'unverified' as const,
  slug: 'my-app',
  token: 'tok_versioned',
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  declaredScopes: [] as string[],
  missingScopes: [] as string[],
  needsConsent: false,
  tokenError: false,
  viewer: { id: 42, username: 'tester' },
  theme: 'light' as const,
};

async function renderedFrame(opts: {
  flags: Record<string, boolean>;
  versionSha?: string | null;
  surface?: BlockHostSurface;
  iframeSrc?: string;
  reviewMode?: boolean;
}): Promise<{ src: string; sandbox: string }> {
  wire = installTrpcWire({});
  const screen = await renderWithTrpcWire(
    <PageBlockHost
      {...props}
      surface={opts.surface ?? 'page-run'}
      iframeSrc={opts.iframeSrc ?? APP_SRC}
      versionSha={opts.versionSha}
      {...(opts.reviewMode ? { reviewMode: true } : {})}
    />,
    {
      viewer: { id: 42, username: 'tester' },
      flags: opts.flags,
      appFrameDomains: { appsDomain: APPS_ROOT, previewDomain: null },
    }
  );
  const iframe = page.getByTestId('app-page-iframe');
  await expect.element(iframe).toBeInTheDocument();
  const el = iframe.element() as HTMLIFrameElement;
  const out = { src: el.getAttribute('src') ?? '', sandbox: el.getAttribute('sandbox') ?? '' };
  await screen.unmount();
  wire.restore();
  wire = undefined;
  return out;
}

/** The frame src without the init fragment (a separate, independently gated feature). */
const base = (src: string) => src.split('#')[0];

const ON = { appBlocksVersionedFramePath: true };

describe('PageBlockHost: versioned frame path', () => {
  test('REGRESSION: flag on + a version sha → the frame loads /v/<sha>/ on the same origin', async () => {
    const { src } = await renderedFrame({ flags: ON, versionSha: SHA });
    expect(base(src)).toBe(`https://my-app.${APPS_ROOT}/v/${SHA}/`);
    expect(new URL(src).origin).toBe(new URL(APP_SRC).origin);
  });

  test('REGRESSION: the private run of a delisted app is framed at its version path too', async () => {
    const { src } = await renderedFrame({ flags: ON, versionSha: SHA, surface: 'private-run' });
    expect(base(src)).toBe(`https://my-app.${APPS_ROOT}/v/${SHA}/`);
  });

  test('CONTROL: flag off → the root, whatever the sha', async () => {
    const { src } = await renderedFrame({ flags: {}, versionSha: SHA });
    expect(base(src)).toBe(APP_SRC);
  });

  test('CONTROL: flag on but no known sha → the root', async () => {
    for (const versionSha of [null, undefined, '', SHA.slice(1), SHA.toUpperCase()]) {
      const { src } = await renderedFrame({ flags: ON, versionSha });
      expect(base(src), String(versionSha)).toBe(APP_SRC);
    }
  });

  test('INVARIANT: review, dev-tunnel and model-slot-shaped surfaces never get a version path', async () => {
    const review = await renderedFrame({
      flags: ON,
      versionSha: SHA,
      surface: 'review-preview',
      reviewMode: true,
      iframeSrc: `https://review-0123456789abcdef.${APPS_ROOT}/`,
    });
    expect(base(review.src)).toBe(`https://review-0123456789abcdef.${APPS_ROOT}/`);
    // 🔴 The dev-tunnel surface is the ONLY one whose Retry swaps in a fresh entry URL, and
    // PageBlockHost compares that entry's base with the `iframeSrc` PROP. That comparison is
    // exact only because the versioned path never applies on this surface, so this pins it
    // with a canonical-looking https src (a mutant that drops the surface gate goes red).
    const dev = await renderedFrame({ flags: ON, versionSha: SHA, surface: 'dev-tunnel' });
    expect(base(dev.src)).toBe(APP_SRC);
  });

  test('INVARIANT: the origin-keyed allow-same-origin grant is unchanged by the version path', async () => {
    const flags = { ...ON, appBlocksSameOriginFrames: true };
    const versioned = await renderedFrame({ flags, versionSha: SHA });
    const root = await renderedFrame({
      flags: { appBlocksSameOriginFrames: true },
      versionSha: SHA,
    });
    expect(base(versioned.src)).toBe(`https://my-app.${APPS_ROOT}/v/${SHA}/`);
    expect(versioned.sandbox.split(/\s+/)).toContain('allow-same-origin');
    expect(versioned.sandbox).toBe(root.sandbox);
  });
});
