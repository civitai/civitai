import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

const m = vi.hoisted(() => ({
  useBlockToken: vi.fn<(...args: unknown[]) => Record<string, unknown>>(),
  hostProps: null as null | Record<string, unknown>,
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
  pageTitle: 'My App',
  status: 'pending',
  trustTier: 'unverified' as const,
  sandbox: 'allow-scripts allow-forms',
  scopes: ['user:read:self'],
  bootSkeleton: false,
  iframeSrc: `https://${HOST}/?dev=t`,
  host: HOST,
};

beforeEach(() => {
  m.useBlockToken.mockReset().mockReturnValue({ token: 't', error: null });
  m.hostProps = null;
});

describe('/apps/dev/[blockId] client', () => {
  test('without a tunnel it explains how to start one and mints no block token', async () => {
    renderWithProviders(<DevTunnelPage {...FRAME} iframeSrc={null} host={null} />);
    await expect.element(page.getByText('No active dev tunnel')).toBeInTheDocument();
    expect(m.useBlockToken).not.toHaveBeenCalled();
    expect(m.hostProps).toBeNull();
  });

  test('never frames without the host the route CSP is built from', async () => {
    renderWithProviders(<DevTunnelPage {...FRAME} host={null} />);
    await expect.element(page.getByText('No active dev tunnel')).toBeInTheDocument();
    expect(m.useBlockToken).not.toHaveBeenCalled();
  });

  test('with a tunnel it mints for the tunnel URL and mounts the dev-tunnel host', async () => {
    renderWithProviders(<DevTunnelPage {...FRAME} />);
    await expect.element(page.getByTestId('page-block-host')).toBeInTheDocument();
    expect(m.useBlockToken).toHaveBeenCalled();
    const install = m.useBlockToken.mock.calls[0][0] as {
      manifest: { iframe: { src: string } };
      blockInstanceId: string;
    };
    expect(install.manifest.iframe.src).toBe(FRAME.iframeSrc);
    expect(m.hostProps).toMatchObject({
      surface: 'dev-tunnel',
      blockInstanceId: 'page_apb_dev',
      iframeSrc: FRAME.iframeSrc,
      appId: 'appblk-my-app',
      token: 't',
      tokenError: false,
      canOpenPage: true,
    });
  });

  test('a failed mint shows the owner-specific copy instead of the host', async () => {
    m.useBlockToken.mockReturnValue({ token: null, error: new Error('nope') });
    renderWithProviders(<DevTunnelPage {...FRAME} />);
    await expect
      .element(page.getByText('Can’t run this app in the dev tunnel'))
      .toBeInTheDocument();
    expect(m.hostProps).toBeNull();
  });
});
