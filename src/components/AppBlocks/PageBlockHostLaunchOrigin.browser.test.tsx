// The scaffold's `next/router` mock exports ONE router singleton as `default`, `Router` and the
// `useRouter()` return value alike, so setting `query` here is what the host reads.
import Router from 'next/router';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';

/**
 * BREADCRUMB BY ORIGIN — the host's half, through the REAL `PageBlockHost`.
 *
 * The run page reads `?from=home` server-side and passes `launchOrigin` to the host; the host
 * threads it to its chrome and never to the embedded app (its one other use, re-stamping the
 * URL a block NAVIGATE pushes, is unit-tested on `resolveNavigateRequest` in
 * `pageBlockHostLogic.test.ts`). Two things are pinned against the real component
 * while the router really carries the signal in its query:
 *   1. the chrome's way out says "My apps" → /apps (the seam the chrome's own suites, which
 *      mount `AppBlockChrome` directly, cannot see);
 *   2. the embedded app never sees it: the iframe `src` is the entry URL unchanged, and the
 *      BLOCK_INIT payload carries no `from` — while the sub-path, which IS forwarded from the
 *      same router query, arrives (the positive control: the forwarding path is live).
 */

const rpc = await vi.hoisted(async () => {
  const { createBridgeRpcMock } = await import('../../../test/bridgeRpcMock');
  return createBridgeRpcMock();
});

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: rpc.trpc,
}));

// eslint-disable-next-line import/first
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';

const router = Router as unknown as { query: Record<string, unknown>; asPath: string };
const SAME_ORIGIN_SRC = `${window.location.origin}/`;

const baseProps = {
  appBlockId: 'apb_origin',
  blockId: 'my-page-app',
  appId: 'app_origin',
  blockInstanceId: 'page_apb_origin',
  appName: 'Origin Test',
  iframeSrc: SAME_ORIGIN_SRC,
  surface: 'page-run' as const,
  bootSkeleton: false,
  sandbox: 'allow-scripts',
  trustTier: 'internal' as const,
  slug: 'my-page-app',
  token: 'tok_abc',
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  declaredScopes: [] as string[],
  missingScopes: [] as string[],
  needsConsent: false,
  tokenError: false,
  viewer: null,
  theme: 'light' as const,
};

const iframeEl = () => page.getByTestId('app-page-iframe').element() as HTMLIFrameElement;

/**
 * The chrome's way out, whichever rendering the measured width gave it: the mobile back
 * chevron (named by `aria-label`) or the desktop breadcrumb's first crumb (named by its text).
 * Both read the same target, so either answers "where does it lead, and what is it called".
 */
function wayOut(): { href: string | null; name: string } {
  const back = document.querySelector('[data-testid="app-block-back"]');
  if (back) {
    return {
      href: back.getAttribute('href'),
      name: (back.getAttribute('aria-label') ?? '').replace(/^Back to /, ''),
    };
  }
  const crumb = document.querySelector('[data-testid="app-block-breadcrumb-apps"]');
  if (!crumb) throw new Error('the chrome has rendered no way out yet');
  return { href: crumb.getAttribute('href'), name: (crumb.textContent ?? '').trim() };
}

let saved: { query: Record<string, unknown>; asPath: string };

beforeEach(() => {
  saved = { query: router.query, asPath: router.asPath };
  router.query = { slug: 'my-page-app', path: ['deep', 'view'], from: 'home' };
  router.asPath = '/apps/run/my-page-app/deep/view?from=home';
});

afterEach(() => {
  router.query = saved.query;
  router.asPath = saved.asPath;
});

describe('PageBlockHost — launch origin', () => {
  test('🔴 the chrome leads back to My apps, and the embedded app never sees the signal', async () => {
    await renderWithProviders(<PageBlockHost {...baseProps} launchOrigin="home" />);
    await vi.waitFor(() => {
      if (!iframeEl().contentWindow) throw new Error('not mounted yet');
    });

    // (2a) the iframe src is the entry URL — no query from the page.
    const src = iframeEl().getAttribute('src') ?? '';
    expect(src.split('#')[0]).toBe(SAME_ORIGIN_SRC);
    // Parsed, not substring-matched: no `from` query parameter, under any value.
    expect(new URL(src, window.location.href).searchParams.has('from')).toBe(false);

    // (2b) BLOCK_INIT: capture it on the frame's side. The host sends it on its own once the
    // frame is mounted and a token is present (the same capture the BLOCK_INIT contract suite
    // uses); posting BLOCK_READY first would mark the frame ready and race that send.
    const inits: unknown[] = [];
    const cw = iframeEl().contentWindow!;
    cw.addEventListener('message', (e: MessageEvent) => {
      const d = e.data as { type?: string; payload?: unknown } | null;
      if (d?.type === 'BLOCK_INIT') inits.push(d.payload);
    });
    await vi.waitFor(() => {
      if (inits.length === 0) throw new Error('listener saw no BLOCK_INIT');
    });
    const init = inits[0] as { context?: Record<string, unknown> };
    // Positive control: the router query DOES reach the block — its sub-path.
    expect(init.context?.subPath).toBe('deep/view');
    // STRUCTURAL, not a substring: the context carries exactly the page-shaped key set, so a
    // new key (a `from`, a `launchOrigin`, a forwarded query) fails here however it is spelt.
    expect(Object.keys(init.context ?? {}).sort()).toEqual(
      ['entityType', 'slotId', 'slug', 'subPath', 'theme', 'viewerUserId', 'viewerUsername'].sort()
    );
    // And nowhere in the whole payload does a `from` / `launchOrigin` key exist, nor any value
    // equal to `home` (the signal's only value) — walked, so nesting cannot hide one.
    const offending: string[] = [];
    let visited = 0;
    (function walk(v: unknown, at: string) {
      visited++;
      if (v === 'home') offending.push(`${at} = "home"`);
      if (!v || typeof v !== 'object') return;
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        if (k === 'from' || k === 'launchOrigin') offending.push(`${at}.${k}`);
        walk(child, `${at}.${k}`);
      }
    })(init, 'BLOCK_INIT');
    expect(visited).toBeGreaterThan(10); // positive control: the walk reached the payload
    expect(offending).toEqual([]);

    // (1) the chrome's way out.
    await vi.waitFor(() => {
      expect(wayOut()).toEqual({ href: '/apps', name: 'My apps' });
    });
  });

  test('without launchOrigin the host keeps the store — Marketplace → /apps/store', async () => {
    router.query = { slug: 'my-page-app' };
    await renderWithProviders(<PageBlockHost {...baseProps} />);
    await vi.waitFor(() => {
      expect(wayOut()).toEqual({ href: '/apps/store', name: 'Marketplace' });
    });
  });
});
