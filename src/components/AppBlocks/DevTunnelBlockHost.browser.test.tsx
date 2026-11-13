import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import router from 'next/router';
import { renderToString } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

const m = vi.hoisted(() => ({
  useBlockToken: vi.fn<(...args: unknown[]) => Record<string, unknown>>(),
  hostProps: null as null | Record<string, unknown>,
  /** Times a PageBlockHost MOUNTED (not rendered) — a remount is what resets its handshake. */
  hostMounts: 0,
  gate: null as null | { blockId: string; onSettled: () => unknown },
}));

vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: () => async () => ({ props: {} }),
}));
vi.mock('~/components/AppBlocks/useBlockToken', () => ({ useBlockToken: m.useBlockToken }));
vi.mock('~/components/AppBlocks/PageBlockHost', async () => {
  const { useEffect } = await import('react');
  return {
    PageBlockHost: (props: Record<string, unknown>) => {
      m.hostProps = props;
      useEffect(() => {
        m.hostMounts += 1;
      }, []);
      return <div data-testid="page-block-host" />;
    },
  };
});
vi.mock('~/components/AppBlocks/DevTunnelDnsGate', () => ({
  DevTunnelDnsGate: (props: NonNullable<typeof m.gate>) => {
    m.gate = props;
    return <div data-testid="dns-gate" />;
  },
}));
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 7, username: 'author' }),
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true, appBlocksPages: true }),
  useOptionalFeatureFlags: () => ({ appBlocks: true, appBlocksPages: true }),
}));

const { default: DevTunnelPage } = await import('~/pages/apps/dev/[blockId]');

const HOST = 'dev-0123456789abcdef.apps.example';
const FRAME = {
  appBlockId: 'apb_dev',
  blockId: 'my-app',
  appId: 'appblk-my-app',
  appName: 'My App',
  trustTier: 'verified' as const,
  sandbox: 'allow-scripts allow-forms',
  scopes: ['user:read:self'],
  bootSkeleton: false,
  iframeSrc: `https://${HOST}/?dev=t`,
  host: HOST,
  dnsPending: false,
};
const PENDING = { ...FRAME, iframeSrc: null, dnsPending: true };
const OTHER = 'dev-fedcba9876543210.apps.example';

/** What the document was loaded with: Next's own data, which client-side navigation keeps. */
function loadedAs(page: string, host: string | null) {
  (window as { __NEXT_DATA__?: unknown }).__NEXT_DATA__ = { page, props: { pageProps: { host } } };
}

beforeEach(() => {
  m.useBlockToken.mockReset().mockReturnValue({ token: 't', error: null });
  m.hostProps = null;
  m.hostMounts = 0;
  m.gate = null;
  vi.mocked(router.reload).mockClear();
  vi.mocked(router.replace).mockClear();
  // The scaffold's shared `next/router` mock.
  (router as { asPath: string }).asPath = '/apps/dev/my-app';
  loadedAs('/apps/dev/[blockId]', HOST);
});
afterEach(() => {
  delete (window as { __NEXT_DATA__?: unknown }).__NEXT_DATA__;
  vi.unstubAllGlobals();
});

describe('/apps/dev/[blockId] client', () => {
  test('without a tunnel it explains how to start one and mints no block token', async () => {
    renderWithProviders(<DevTunnelPage {...FRAME} iframeSrc={null} host={null} />);
    await expect.element(page.getByText('No active dev tunnel')).toBeInTheDocument();
    expect(m.useBlockToken).not.toHaveBeenCalled();
    expect(m.hostProps).toBeNull();
  });

  test('with a tunnel it mints for the tunnel URL and mounts the dev-tunnel host', async () => {
    renderWithProviders(<DevTunnelPage {...FRAME} />);
    await expect.element(page.getByTestId('page-block-host')).toBeInTheDocument();
    expect(m.useBlockToken).toHaveBeenCalled();
    // Marks the mint as a tunnel preview, so the token carries no document-store scopes.
    expect(m.useBlockToken.mock.calls[0][2]).toEqual({ devTunnel: true });
    expect(m.useBlockToken.mock.calls[0][0]).toMatchObject({
      blockInstanceId: 'page_apb_dev',
      trustTier: 'verified',
      manifest: {
        scopes: ['user:read:self'],
        iframe: {
          src: FRAME.iframeSrc,
          minHeight: 200,
          maxHeight: null,
          resizable: true,
          sandbox: 'allow-scripts allow-forms',
        },
      },
    });
    expect(m.hostProps).toMatchObject({
      sandbox: 'allow-scripts allow-forms',
      trustTier: 'verified',
      declaredScopes: ['user:read:self'],
      surface: 'dev-tunnel',
      blockInstanceId: 'page_apb_dev',
      iframeSrc: FRAME.iframeSrc,
      appId: 'appblk-my-app',
      token: 't',
      tokenError: false,
      canOpenPage: true,
      fit: 'viewport',
    });
  });

  test('forwards the mint-signed scopes, so the host advertises the clamped set, not the manifest', async () => {
    // The owned dev-tunnel mint signs a clamped set that can differ from the
    // manifest; a set distinct from FRAME.scopes proves it is the hook's value.
    m.useBlockToken.mockReturnValue({
      token: 't',
      error: null,
      signedScopes: ['apps:storage:read'],
    });
    renderWithProviders(<DevTunnelPage {...FRAME} />);
    await expect.element(page.getByTestId('page-block-host')).toBeInTheDocument();
    expect(m.hostProps?.signedScopes).toEqual(['apps:storage:read']);
  });

  test('a failed mint shows the owner-specific copy instead of the host', async () => {
    m.useBlockToken.mockReturnValue({ token: null, error: new Error('nope') });
    renderWithProviders(<DevTunnelPage {...FRAME} />);
    await expect
      .element(page.getByText('Can’t run this app in the dev tunnel'))
      .toBeInTheDocument();
    expect(m.hostProps).toBeNull();
  });

  test('while the tunnel host is not resolvable it shows the gate and mounts no host', async () => {
    await renderWithProviders(<DevTunnelPage {...PENDING} />);
    await expect.element(page.getByTestId('dns-gate')).toBeInTheDocument();
    expect(m.hostProps, 'the app was framed before its host resolved').toBeNull();
    expect(m.useBlockToken).not.toHaveBeenCalled();
    expect(page.getByText('No active dev tunnel').query()).toBeNull();
    expect(m.gate!.blockId).toBe('my-app');
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.reload).not.toHaveBeenCalled();
  });

  test('branches on dnsPending itself: a pending frame is never mounted even if it carries a URL', async () => {
    await renderWithProviders(<DevTunnelPage {...FRAME} dnsPending />);
    await expect.element(page.getByTestId('dns-gate')).toBeInTheDocument();
    expect(m.hostProps).toBeNull();
  });

  test('re-runs its server props, in place, when the gate settles, and hands the gate that promise', async () => {
    const transition = Promise.resolve(true);
    vi.mocked(router.replace).mockReturnValue(transition);
    await renderWithProviders(<DevTunnelPage {...PENDING} />);
    await expect.element(page.getByTestId('dns-gate')).toBeInTheDocument();
    expect(m.gate!.onSettled()).toBe(transition);
    expect(router.replace).toHaveBeenCalledExactlyOnceWith('/apps/dev/my-app', undefined, {
      scroll: false,
    });
    expect(router.reload).not.toHaveBeenCalled();
  });

  test('re-fetched props for a different host reload the document instead of framing it', async () => {
    const screen = await renderWithProviders(<DevTunnelPage {...PENDING} />);
    await expect.element(page.getByTestId('dns-gate')).toBeInTheDocument();

    // The tunnel restarted while the page waited: a new host, which this document's CSP forbids.
    await screen.rerender(
      <DevTunnelPage {...FRAME} host={OTHER} iframeSrc={`https://${OTHER}/?dev=t`} />
    );
    await vi.waitFor(() => expect(router.reload).toHaveBeenCalledTimes(1));
    expect(m.hostProps, 'a host this document may not frame was mounted').toBeNull();
  });

  test('reached client-side with a host other than the one the document was loaded with, it reloads', async () => {
    // Back to this page after the tunnel restarted elsewhere: the first props are already new.
    await renderWithProviders(
      <DevTunnelPage {...FRAME} host={OTHER} iframeSrc={`https://${OTHER}/?dev=t`} />
    );
    await vi.waitFor(() => expect(router.reload).toHaveBeenCalledTimes(1));
    expect(m.hostProps, 'a host this document may not frame was mounted').toBeNull();
  });

  test('a document loaded as another page, or with no tunnel, frames a host without a reload', async () => {
    // Another page's props, even one that happens to carry a `host`, say nothing about this CSP.
    loadedAs('/apps', OTHER);
    const first = await renderWithProviders(<DevTunnelPage {...FRAME} />);
    await expect.element(page.getByTestId('page-block-host')).toBeInTheDocument();
    await first.unmount();

    loadedAs('/apps/dev/[blockId]', null);
    m.hostProps = null;
    const screen = await renderWithProviders(
      <DevTunnelPage {...FRAME} iframeSrc={null} host={null} />
    );
    await expect.element(page.getByText('No active dev tunnel')).toBeInTheDocument();
    await screen.rerender(<DevTunnelPage {...FRAME} />);
    await expect.element(page.getByTestId('page-block-host')).toBeInTheDocument();
    expect(m.hostProps).not.toBeNull();
    expect(router.reload).not.toHaveBeenCalled();
  });

  test('a new host that is still pending reloads rather than waiting under the old policy', async () => {
    const screen = await renderWithProviders(<DevTunnelPage {...PENDING} />);
    await expect.element(page.getByTestId('dns-gate')).toBeInTheDocument();
    await screen.rerender(<DevTunnelPage {...PENDING} host={OTHER} />);
    await vi.waitFor(() => expect(router.reload).toHaveBeenCalledTimes(1));
    expect(page.getByTestId('dns-gate').query()).toBeNull();
  });

  test('re-fetched props for the same host mount it without a reload', async () => {
    const screen = await renderWithProviders(<DevTunnelPage {...PENDING} />);
    await expect.element(page.getByTestId('dns-gate')).toBeInTheDocument();
    await screen.rerender(<DevTunnelPage {...FRAME} />);
    await expect.element(page.getByTestId('page-block-host')).toBeInTheDocument();
    expect(router.reload).not.toHaveBeenCalled();
  });

  // 🔴 REGRESSION (live reload). The app reloaded itself inside the frame (Vite) after it
  // was ready; the host reports it, and the page re-runs its server props — the SAME
  // in-place path the DNS gate uses — for a freshly signed entry URL.
  test('a guest reload re-runs the server props in place, once', async () => {
    renderWithProviders(<DevTunnelPage {...FRAME} />);
    await expect.element(page.getByTestId('page-block-host')).toBeInTheDocument();
    const onGuestReloaded = m.hostProps?.onGuestReloaded;
    expect(onGuestReloaded, 'the page gave the host no way to report a reload').toBeTypeOf(
      'function'
    );

    (onGuestReloaded as () => void)();
    expect(router.replace).toHaveBeenCalledExactlyOnceWith('/apps/dev/my-app', undefined, {
      scroll: false,
    });
    expect(router.reload).not.toHaveBeenCalled();
  });

  test('a freshly signed entry URL for the same host REMOUNTS the host', async () => {
    // A remount is what resets the host's handshake: re-rendering the same instance with
    // a new src would load the new document into a host still parked on `ready`.
    const screen = await renderWithProviders(<DevTunnelPage {...FRAME} />);
    await expect.element(page.getByTestId('page-block-host')).toBeInTheDocument();
    expect(m.hostMounts).toBe(1);

    await screen.rerender(<DevTunnelPage {...FRAME} iframeSrc={`https://${HOST}/?dev=t2`} />);
    await vi.waitFor(() => expect(m.hostProps?.iframeSrc).toBe(`https://${HOST}/?dev=t2`));
    expect(m.hostMounts).toBe(2);
    expect(router.reload).not.toHaveBeenCalled();
  });

  // 🔴 REGRESSION (round-1 audit). Live reload counts the frame's `load` events, so the
  // frame must never be in the server-rendered HTML: there it can finish loading before
  // hydration attaches the listener, and the missed load hides the first reload for good.
  test('the dev-tunnel host is not server-rendered — it mounts on the client', async () => {
    const html = renderToString(
      <MantineProvider>
        <DevTunnelPage {...FRAME} />
      </MantineProvider>
    );
    expect(html).not.toContain('data-testid="page-block-host"');

    // Positive control: the same page does mount the host once on the client.
    renderWithProviders(<DevTunnelPage {...FRAME} />);
    await expect.element(page.getByTestId('page-block-host')).toBeInTheDocument();
  });

  test('CONTROL: re-rendering with the SAME entry URL does not remount', async () => {
    const screen = await renderWithProviders(<DevTunnelPage {...FRAME} />);
    await expect.element(page.getByTestId('page-block-host')).toBeInTheDocument();
    await screen.rerender(<DevTunnelPage {...FRAME} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(m.hostMounts).toBe(1);
  });

  // INVARIANT, not regression coverage: the mocked host never reports a reload on its
  // own, so this cannot see a loop — the no-loop property lives in PageBlockHost's
  // once-per-mount report. What it pins is that the page settles on the start commands.
  test('a fresh mint that comes back with no tunnel shows the start commands', async () => {
    const screen = await renderWithProviders(<DevTunnelPage {...FRAME} />);
    await expect.element(page.getByTestId('page-block-host')).toBeInTheDocument();
    (m.hostProps?.onGuestReloaded as () => void)();

    // The tunnel went away between the reload and the re-mint.
    await screen.rerender(<DevTunnelPage {...FRAME} iframeSrc={null} host={null} />);
    await expect.element(page.getByText('No active dev tunnel')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.reload).not.toHaveBeenCalled();
  });

  // The CLI command is `civitai app dev-tunnel` (no colon), and the scaffolds' `npm run dev:tunnel`
  // serves on the port it tunnels and sends the headers that let this page frame the app.
  const COMMANDS = 'npm run dev:tunnel\ncivitai app dev-tunnel';
  const commandBlocks = (container: HTMLElement) =>
    [...container.querySelectorAll('pre')].map((el) => el.textContent);

  test('without a tunnel it shows the commands that start one', async () => {
    const screen = await renderWithProviders(
      <DevTunnelPage {...FRAME} iframeSrc={null} host={null} />
    );
    await expect.element(page.getByText('No active dev tunnel')).toBeInTheDocument();
    expect(commandBlocks(screen.container)).toEqual([COMMANDS]);
  });

  test('a failed mint shows only the tunnel command to restart', async () => {
    m.useBlockToken.mockReturnValue({ token: null, error: new Error('nope') });
    const screen = await renderWithProviders(<DevTunnelPage {...FRAME} />);
    await expect
      .element(page.getByText('Can’t run this app in the dev tunnel'))
      .toBeInTheDocument();
    expect(commandBlocks(screen.container)).toEqual(['civitai app dev-tunnel']);
  });

  test('a resolvable tunnel never shows the gate', async () => {
    await renderWithProviders(<DevTunnelPage {...FRAME} />);
    await expect.element(page.getByTestId('page-block-host')).toBeInTheDocument();
    expect(m.gate).toBeNull();
  });
});

/** The host's half of a Retry is pinned in `PageBlockHostAutoRetry.browser.test.tsx`. */
describe('/apps/dev/[blockId] client — the frame retries on a fresh entry URL', () => {
  const FRESH_SRC = `https://${HOST}/?dev=fresh-entry-token`;
  const fetchMock = vi.fn<(...args: unknown[]) => Promise<Response>>();
  const answer = (status: number, body: unknown) =>
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    );
  const refreshOf = () => m.hostProps?.onRefreshEntryUrl as undefined | (() => Promise<string>);

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  test('a Retry fetches a freshly signed URL for this app, and the host loads it without a remount', async () => {
    answer(200, { iframeSrc: FRESH_SRC, host: HOST });
    await renderWithProviders(<DevTunnelPage {...FRAME} />);
    await expect.element(page.getByTestId('page-block-host')).toBeInTheDocument();
    expect(refreshOf(), 'the page gave the host no fresh URL for a Retry').toBeTypeOf('function');
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(refreshOf()!()).resolves.toBe(FRESH_SRC);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/apps/dev/entry-url?blockId=my-app');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: 'same-origin' });
    // In place: no server-props re-run, no reload, no remount (the auto-retry budget survives).
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.reload).not.toHaveBeenCalled();
    expect(m.hostMounts).toBe(1);
  });

  test('the block id is encoded into the request', async () => {
    answer(200, { iframeSrc: FRESH_SRC, host: HOST });
    await renderWithProviders(<DevTunnelPage {...FRAME} blockId="a&b=c" />);
    await expect.element(page.getByTestId('page-block-host')).toBeInTheDocument();
    await refreshOf()!();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/apps/dev/entry-url?blockId=a%26b%3Dc');
  });

  test.each([
    [404, { error: 'App not found' }],
    [409, { error: 'No live dev tunnel' }],
    [200, { host: HOST }],
    [200, { iframeSrc: '', host: HOST }],
    [200, { iframeSrc: `http://${HOST}/?dev=x`, host: HOST }],
    [200, { iframeSrc: 'not a url', host: HOST }],
  ])(
    'an answer with no usable URL (%i %j) rejects, so the host re-arms on the URL it has',
    async (status, body) => {
      answer(status, body);
      await renderWithProviders(<DevTunnelPage {...FRAME} />);
      await expect.element(page.getByTestId('page-block-host')).toBeInTheDocument();
      await expect(refreshOf()!()).rejects.toThrow();
      expect(router.reload).not.toHaveBeenCalled();
    }
  );

  test('a fresh URL on another host is never framed: the page reloads for a document whose policy allows it', async () => {
    answer(200, { iframeSrc: `https://${OTHER}/?dev=fresh`, host: OTHER });
    await renderWithProviders(<DevTunnelPage {...FRAME} />);
    await expect.element(page.getByTestId('page-block-host')).toBeInTheDocument();
    await expect(refreshOf()!()).rejects.toThrow();
    expect(router.reload).toHaveBeenCalledTimes(1);
  });

  test('a URL whose origin is not the host it names is refused', async () => {
    answer(200, { iframeSrc: `https://${OTHER}/?dev=fresh`, host: HOST });
    await renderWithProviders(<DevTunnelPage {...FRAME} />);
    await expect.element(page.getByTestId('page-block-host')).toBeInTheDocument();
    await expect(refreshOf()!()).rejects.toThrow('The entry URL is not on its tunnel host');
    expect(router.reload).not.toHaveBeenCalled();
  });
});
