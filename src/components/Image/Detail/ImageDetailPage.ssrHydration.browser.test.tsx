import * as React from 'react';
import { renderToString } from 'react-dom/server';
import type { Root } from 'react-dom/client';
import { hydrateRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as NextRouterModule from 'next/router';
import type * as ImageDetailProviderModule from '~/components/Image/Detail/ImageDetailProvider';
import type * as ImageDetail2Module from '~/components/Image/DetailV2/ImageDetail2';
import type * as StorylineModule from '~/components/Storyline/StorylineModeProvider';

/**
 * `/images/[imageId]` on a static shell boot: the server HTML is the skeleton (the shell carries
 * no route query and no page data), the hydration render reproduces it exactly, and the image tree
 * mounts only once the page data is adopted AND the router holds the real `imageId` — never with
 * the shell's empty query. Real `renderToString` → `hydrateRoot`, as in
 * `ThirdPartyConsentProvider.ssrHydration.browser.test.tsx`. The image tree itself is replaced by a
 * probe that records the `imageId` it was given.
 */

const router = vi.hoisted(() => ({
  pathname: '/images/[imageId]',
  asPath: '/images/123?postId=5#comments',
  query: {} as Record<string, string>,
  replace: vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true),
  events: { on: () => undefined, off: () => undefined },
}));

vi.mock('next/router', async (importOriginal) => ({
  ...(await importOriginal<typeof NextRouterModule>()),
  useRouter: () => router,
}));

const mounted = vi.hoisted(() => [] as unknown[]);
vi.mock('~/components/Image/Detail/ImageDetailProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageDetailProviderModule>()),
  ImageDetailProvider: ({ imageId, children }: { imageId: unknown; children: React.ReactNode }) => {
    mounted.push(imageId);
    return (
      <div data-testid="image-detail" data-image-id={String(imageId)}>
        {children}
      </div>
    );
  },
}));
vi.mock('~/components/Image/DetailV2/ImageDetail2', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageDetail2Module>()),
  ImageDetail2: () => null,
}));
vi.mock('~/components/Storyline/StorylineModeProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof StorylineModule>()),
  StorylineModeProvider: ({
    children,
  }: {
    children: (images: [], key: string) => React.ReactNode;
  }) => children([], 'mode'),
}));

const { ImageDetailPage } = await import('~/components/Image/Detail/ImageDetailPage');
const { ShellBootstrapProvider } = await import('~/components/Shell/ShellBootstrapProvider');
const { BrowserRouterProvider } = await import('~/components/BrowserRouter/BrowserRouterProvider');
const { shellNavigation } = await import('~/components/Shell/shell-page-data');

type Status = 'pending' | 'ready' | 'failed';

function Tree({ status }: { status: Status }) {
  return (
    <ShellBootstrapProvider status={status}>
      <BrowserRouterProvider>
        <ImageDetailPage />
      </BrowserRouterProvider>
    </ShellBootstrapProvider>
  );
}

const HYDRATION_RE =
  /(Hydration failed|An error occurred during hydration|The server HTML was replaced|Expected server HTML|did not match|Text content does not match)/i;

let consoleErrors: string[] = [];
let recoverable: string[] = [];
let restoreConsole: (() => void) | null = null;
const roots: Root[] = [];
const containers: HTMLElement[] = [];

beforeEach(() => {
  window.history.replaceState(null, '', '/images/123?postId=5#comments');
  router.query = {};
  router.replace.mockReset();
  router.replace.mockImplementation(async () => true);
  mounted.length = 0;
  consoleErrors = [];
  recoverable = [];
  const original = console.error;
  console.error = ((...args: unknown[]) => {
    consoleErrors.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
    original.apply(console, args as []);
  }) as typeof console.error;
  restoreConsole = () => {
    console.error = original;
  };
});

afterEach(() => {
  restoreConsole?.();
  for (const r of roots.splice(0)) r.unmount();
  for (const c of containers.splice(0)) c.remove();
  vi.restoreAllMocks();
});

async function flush() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function hydrate(status: Status) {
  const html = renderToString(<Tree status={status} />);
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.appendChild(container);
  containers.push(container);
  const root = hydrateRoot(container, <Tree status={status} />, {
    onRecoverableError: (err) => recoverable.push(err instanceof Error ? err.message : String(err)),
  });
  roots.push(root);
  await flush();
  return { html, container, root };
}

/** What Next does when the router's replace lands: the router now holds the real query. */
async function applyRealQuery(root: Root, status: Status) {
  router.query = { imageId: '123', postId: '5' };
  React.startTransition(() => root.render(<Tree status={status} />));
  await flush();
}

describe('the image page on a shell boot', () => {
  test('INSTRUMENT CHECK: a genuine server/client divergence IS reported', async () => {
    let onServer = true;
    function Diverges() {
      return onServer ? <p>server</p> : <span>client</span>;
    }
    const html = renderToString(<Diverges />);
    onServer = false;
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    containers.push(container);
    roots.push(
      hydrateRoot(container, <Diverges />, {
        onRecoverableError: (err) =>
          recoverable.push(err instanceof Error ? err.message : String(err)),
      })
    );
    await flush();
    expect(
      recoverable.length + consoleErrors.filter((e) => HYDRATION_RE.test(e)).length
    ).toBeGreaterThan(0);
  });

  test('server HTML is the skeleton, and hydrates over it with no error', async () => {
    const { html, container } = await hydrate('pending');
    expect(html).toContain('data-testid="image-detail-shell-skeleton"');
    expect(html).not.toContain('data-testid="image-detail"');
    expect(recoverable).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(container.querySelector('[data-testid="image-detail-shell-skeleton"]')).not.toBeNull();
    expect(mounted).toEqual([]);
  });

  test('restores the route query from the address bar once, without a navigation', async () => {
    await hydrate('pending');
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith(
      '/images/[imageId]?postId=5',
      '/images/123?postId=5#comments',
      { shallow: true, scroll: false, _h: 1 }
    );
  });

  test('page data adopted but the query not yet restored: still the skeleton', async () => {
    const { container } = await hydrate('ready');
    expect(container.querySelector('[data-testid="image-detail-shell-skeleton"]')).not.toBeNull();
    expect(mounted).toEqual([]);
  });

  test('query restored but page data still pending: still the skeleton', async () => {
    const { container, root } = await hydrate('pending');
    await applyRealQuery(root, 'pending');
    expect(container.querySelector('[data-testid="image-detail-shell-skeleton"]')).not.toBeNull();
    expect(mounted).toEqual([]);
  });

  test('both: the image tree mounts with the real imageId, and only that one', async () => {
    const { container, root } = await hydrate('pending');
    await applyRealQuery(root, 'ready');
    const detail = container.querySelector('[data-testid="image-detail"]');
    expect(detail?.getAttribute('data-image-id')).toBe('123');
    expect(mounted.length).toBeGreaterThan(0);
    expect(new Set(mounted)).toEqual(new Set(['123']));
    expect(consoleErrors).toEqual([]);
  });

  test('a restore that fails leaves the shell for a full render', async () => {
    router.replace.mockImplementation(async () => {
      throw new Error('route change failed');
    });
    const navigate = vi.spyOn(shellNavigation, 'replace').mockImplementation(() => undefined);
    await hydrate('pending');
    expect(navigate).toHaveBeenCalledWith('/images/123?postId=5&civ-shell=0#comments');
  });
});
