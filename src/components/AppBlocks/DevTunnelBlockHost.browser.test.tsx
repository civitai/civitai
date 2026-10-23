import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import router from 'next/router';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

const m = vi.hoisted(() => ({
  useBlockToken: vi.fn<(...args: unknown[]) => Record<string, unknown>>(),
  hostProps: null as null | Record<string, unknown>,
  gate: null as null | { blockId: string; onSettled: () => unknown },
}));

vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: () => async () => ({ props: {} }),
}));
vi.mock('~/components/AppBlocks/useBlockToken', () => ({ useBlockToken: m.useBlockToken }));
vi.mock('~/components/AppBlocks/PageBlockHost', () => ({
  PageBlockHost: (props: Record<string, unknown>) => {
    m.hostProps = props;
    return <div data-testid="page-block-host" />;
  },
}));
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
  m.gate = null;
  vi.mocked(router.reload).mockClear();
  vi.mocked(router.replace).mockClear();
  // The scaffold's shared `next/router` mock.
  (router as { asPath: string }).asPath = '/apps/dev/my-app';
  loadedAs('/apps/dev/[blockId]', HOST);
});
afterEach(() => {
  delete (window as { __NEXT_DATA__?: unknown }).__NEXT_DATA__;
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
