import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';

/**
 * `/apps/dev/[blockId]` and its Retry endpoint (`/api/apps/dev/entry-url`) refuse the same
 * requests: page `notFound` ⇔ endpoint 404, no URL on the page ⇔ endpoint 409. Both run the real
 * gate chain; only its data sources are stubbed.
 */

const m = vi.hoisted(() => ({
  author: { id: 555, username: 'dev', isModerator: false },
  pageResolver: null as null | ((c: any) => Promise<any>),
  features: { current: {} as Record<string, boolean> },
  devTunnelEnabled: vi.fn<(...a: unknown[]) => Promise<boolean>>(),
  resolveDev: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  activeTunnel: vi.fn<(...a: unknown[]) => Promise<unknown>>(),
  hostPublished: vi.fn<(host: string) => Promise<boolean>>(),
}));

vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: (opts: { resolver: (c: any) => Promise<any> }) => {
    m.pageResolver = opts.resolver;
    return async () => ({ props: {} });
  },
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  AuthedEndpoint:
    (handler: (req: unknown, res: unknown, user: unknown) => Promise<unknown>) =>
    (req: unknown, res: unknown) =>
      handler(req, res, m.author),
}));
vi.mock('~/server/utils/require-full-scope-session', () => ({
  requireFullScopeSession: () => true,
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlagsAsync: async () => m.features.current,
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksDevTunnelEnabled: (...a: unknown[]) => m.devTunnelEnabled(...a),
  isAppBlocksDevTunnelUnsubmittedSpendEnabled: async () => true,
}));
vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: { resolveDevPageBlockForAuthor: (...a: unknown[]) => m.resolveDev(...a) },
}));
vi.mock('~/server/services/blocks/dev-tunnel.service', () => ({
  getActiveDevTunnel: (...a: unknown[]) => m.activeTunnel(...a),
}));
vi.mock('~/server/services/blocks/dev-tunnel-dns.service', () => ({
  isDevTunnelHostPublished: (host: string) => m.hostPublished(host),
}));

// Component deps stubbed so importing the page module doesn't pull a DOM.
vi.mock('@mantine/core', () => ({
  Alert: () => null,
  Box: () => null,
  Code: () => null,
  Stack: () => null,
  Text: () => null,
  Title: () => null,
  useComputedColorScheme: () => 'dark',
}));
vi.mock('~/components/AppBlocks/PageBlockHost', () => ({ PageBlockHost: () => null }));
vi.mock('~/components/AppBlocks/DevTunnelDnsGate', () => ({ DevTunnelDnsGate: () => null }));
vi.mock('~/components/AppBlocks/useBlockToken', () => ({ useBlockToken: () => ({}) }));
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

const { env } = await import('~/env/server');
await import('~/pages/apps/dev/[blockId]');
const endpoint = (await import('~/pages/api/apps/dev/entry-url')).default as unknown as (
  req: unknown,
  res: unknown
) => Promise<void>;

const SECRET = 'test-nextauth-secret-ffffffffffffffffffff';
const AUTHOR = m.author;
const HOST = `dev-0f1e2d3c4b5a6978.${env.APPS_DOMAIN}`;
const DEV_APP = {
  appBlockId: 'apb_dev',
  blockId: 'my-app',
  appId: 'appblk-my-app',
  status: 'pending',
  trustTier: 'unverified' as const,
  name: 'My App',
  sandbox: 'allow-scripts',
  scopes: [] as string[],
  bootSkeleton: false,
};
const tunnel = {
  sessionId: 'bki_s',
  userId: AUTHOR.id,
  blockId: 'my-app',
  host: HOST,
  hardExpiresAt: 9e9,
  spendCapBuzz: 5000,
};
const ON = { appBlocks: true, appBlocksAuthor: true };

beforeEach(() => {
  vi.stubEnv('NEXTAUTH_SECRET', SECRET);
  m.devTunnelEnabled.mockReset().mockResolvedValue(true);
  m.resolveDev.mockReset().mockResolvedValue(DEV_APP);
  m.activeTunnel.mockReset().mockResolvedValue(tunnel);
  m.hostPublished.mockReset().mockResolvedValue(true);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function both(features: Record<string, boolean>) {
  if (!m.pageResolver) throw new Error('page resolver not captured');
  const page = await m.pageResolver({
    features,
    session: { user: AUTHOR },
    ctx: {
      params: { blockId: 'my-app' },
      resolvedUrl: '/apps/dev/my-app',
      req: { headers: { host: 'civitai.com' } },
      res: { setHeader: () => undefined },
    },
  });
  m.features.current = features;
  let status = 200;
  let body: unknown;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(value: unknown) {
      body = value;
      return res;
    },
    setHeader: () => res,
  };
  await endpoint(
    { method: 'GET', url: '/api/apps/dev/entry-url', query: { blockId: 'my-app' } },
    res
  );
  return { page, endpoint: { status, body } };
}

describe('/apps/dev/[blockId] and its Retry endpoint apply the same gates', () => {
  const refusals: [string, Record<string, boolean>, () => void][] = [
    ['App Blocks off', { appBlocksAuthor: true }, () => {}],
    ['the author capability off', { appBlocks: true }, () => {}],
    ['the kill switch off', ON, () => void m.devTunnelEnabled.mockResolvedValue(false)],
    ['a block the caller does not own', ON, () => void m.resolveDev.mockResolvedValue(null)],
  ];
  it.each(refusals)(
    '%s: the page is notFound and the endpoint the same bare 404',
    async (_n, features, arrange) => {
      arrange();
      const { page, endpoint: answer } = await both(features);
      expect(page).toEqual({ notFound: true });
      expect(answer).toEqual({ status: 404, body: { error: 'App not found' } });
    }
  );

  const noUrl: [string, () => void][] = [
    ['no live tunnel', () => void m.activeTunnel.mockResolvedValue(null)],
    ['the host not published yet', () => void m.hostPublished.mockResolvedValue(false)],
  ];
  it.each(noUrl)('%s: neither signs an entry URL', async (_n, arrange) => {
    arrange();
    const { page, endpoint: answer } = await both(ON);
    expect(page.props.iframeSrc).toBeNull();
    expect(answer.status).toBe(409);
    expect(JSON.stringify(answer.body)).not.toContain('?dev=');
  });

  it('POSITIVE CONTROL: with every gate open, both sign a URL on the same tunnel host', async () => {
    const { page, endpoint: answer } = await both(ON);
    const shape = new RegExp(`^https://${HOST.replace(/\./g, '\\.')}/\\?dev=[^&]+$`);
    expect(page.props.iframeSrc).toMatch(shape);
    expect(answer).toEqual({
      status: 200,
      body: { iframeSrc: expect.stringMatching(shape), host: HOST },
    });
  });
});
