import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DevTunnelSession from '~/server/services/blocks/dev-tunnel-session';
import type { SessionUser } from '~/types/session';

const { resolveDev, activeTunnel, unsubmittedSpend, sign, published } = vi.hoisted(() => ({
  published: vi.fn<(host: string) => Promise<boolean>>(async () => true),
  resolveDev: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  activeTunnel: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  unsubmittedSpend: vi.fn(async () => false),
  sign: vi.fn(() => 'signed.entry+token'),
}));

vi.mock('~/env/server', () => ({ env: { APPS_DOMAIN: 'apps.example' } }));
vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: { resolveDevPageBlockForAuthor: resolveDev },
}));
vi.mock('~/server/services/blocks/dev-tunnel.service', () => ({
  getActiveDevTunnel: activeTunnel,
}));
vi.mock('~/server/services/blocks/dev-tunnel-dns.service', () => ({
  isDevTunnelHostPublished: published,
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksDevTunnelUnsubmittedSpendEnabled: unsubmittedSpend,
}));
// The real host check; only the signature is stubbed.
vi.mock('~/server/services/blocks/dev-tunnel-session', async (importOriginal) => ({
  ...(await importOriginal<typeof DevTunnelSession>()),
  signDevTunnelAccessToken: sign,
}));

const { resolveDevTunnelFrame } = await import('../dev-tunnel-frame.service');

const USER = { id: 42 } as SessionUser;
const APP = {
  appBlockId: 'ephemeral-my-app',
  blockId: 'my-app',
  appId: 'appblk-my-app',
  status: 'ephemeral',
  trustTier: 'unverified',
  name: 'My App',
  pageTitle: 'My App page',
  sandbox: 'allow-scripts allow-forms',
  scopes: ['user:read:self'],
  bootSkeleton: false,
  contentRating: null,
};
const HOST = 'dev-0123456789abcdef.apps.example';

beforeEach(() => {
  vi.clearAllMocks();
  resolveDev.mockResolvedValue(APP);
  activeTunnel.mockResolvedValue({
    host: HOST,
    grantedScopes: ['ai:write:budgeted', 'user:read:self'],
  });
  unsubmittedSpend.mockResolvedValue(true);
  published.mockResolvedValue(true);
});

describe('resolveDevTunnelFrame', () => {
  it("resolves the app with the tunnel session's scopes and the spend flag, and signs an entry URL", async () => {
    const frame = await resolveDevTunnelFrame(USER, 'my-app');

    expect(resolveDev).toHaveBeenCalledWith('my-app', 42, {
      sessionGrantedScopes: ['ai:write:budgeted', 'user:read:self'],
      unsubmittedSpendAllowed: true,
    });
    expect(activeTunnel).toHaveBeenCalledWith(42, 'my-app');
    expect(unsubmittedSpend).toHaveBeenCalledWith({ user: USER });
    expect(sign).toHaveBeenCalledWith({ userId: 42, host: HOST });
    expect(frame).toEqual({
      appBlockId: 'ephemeral-my-app',
      blockId: 'my-app',
      appId: 'appblk-my-app',
      appName: 'My App',
      trustTier: 'unverified',
      sandbox: 'allow-scripts allow-forms',
      scopes: ['user:read:self'],
      bootSkeleton: false,
      host: HOST,
      iframeSrc: `https://${HOST}/?dev=signed.entry%2Btoken`,
      dnsPending: false,
    });
    expect(published).toHaveBeenCalledExactlyOnceWith(HOST);
  });

  it("withholds the entry URL until the tunnel host's DNS record is published", async () => {
    published.mockResolvedValue(false);
    expect(await resolveDevTunnelFrame(USER, 'my-app')).toMatchObject({
      host: HOST,
      iframeSrc: null,
      dnsPending: true,
    });
    // No entry token is minted for a host nothing may load yet: it would expire during the wait.
    expect(sign).not.toHaveBeenCalled();

    published.mockResolvedValue(true);
    expect(await resolveDevTunnelFrame(USER, 'my-app')).toMatchObject({
      iframeSrc: `https://${HOST}/?dev=signed.entry%2Btoken`,
      dnsPending: false,
    });
  });

  it('passes the spend flag through when it is off', async () => {
    unsubmittedSpend.mockResolvedValue(false);
    await resolveDevTunnelFrame(USER, 'my-app');
    expect(resolveDev).toHaveBeenCalledWith(
      'my-app',
      42,
      expect.objectContaining({ unsubmittedSpendAllowed: false })
    );
  });

  it('is null for an app the caller does not own', async () => {
    resolveDev.mockResolvedValue(null);
    expect(await resolveDevTunnelFrame(USER, 'their-app')).toBeNull();
    expect(sign).not.toHaveBeenCalled();
  });

  it('has no URL without a live tunnel', async () => {
    activeTunnel.mockResolvedValue(null);
    expect(await resolveDevTunnelFrame(USER, 'my-app')).toMatchObject({
      host: null,
      iframeSrc: null,
      dnsPending: false,
    });
    expect(published).not.toHaveBeenCalled();
    expect(resolveDev).toHaveBeenCalledWith('my-app', 42, {
      sessionGrantedScopes: undefined,
      unsubmittedSpendAllowed: true,
    });
  });

  it.each([
    ['dev-0123456789abcdef.elsewhere.example'],
    ['myapp.apps.example'],
    ['dev-xyz.apps.example'],
  ])('never frames a host outside the dev-host shape: %s', async (host) => {
    activeTunnel.mockResolvedValue({ host, grantedScopes: [] });
    expect(await resolveDevTunnelFrame(USER, 'my-app')).toMatchObject({
      host: null,
      iframeSrc: null,
      dnsPending: false,
    });
    expect(published).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
  });
});
