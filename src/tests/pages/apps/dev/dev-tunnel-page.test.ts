import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * APP DEV TUNNEL — `/apps/dev/[blockId]` SSR resolver.
 *
 *   - author + owner + flags + active tunnel → iframeSrc = https://<dev-host>/?dev=<token>
 *     (server-derived host ONLY; strict `dev-<16hex>` shape) + a ROUTE-SCOPED CSP
 *     header (frame-src the exact dev host).
 *   - unauthenticated → redirect to login.
 *   - non-owner (resolver null) → notFound.
 *   - flag off / author cap off → notFound.
 *   - a foreign/invalid tunnel host is NEVER reflected into iframeSrc (T6).
 *   - the GLOBAL CSP is unchanged: a DIFFERENT route's resolver sets no CSP.
 */

const { capturedDev, capturedRun } = vi.hoisted(() => ({
  capturedDev: { fn: null as null | ((c: any) => Promise<any>) },
  capturedRun: { fn: null as null | ((c: any) => Promise<any>) },
}));

// Capture BOTH resolvers from the two page modules. The dev page is imported
// first, the run page second, so route to the right capture by call order.
let sspCallCount = 0;
vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: (opts: { resolver: (c: any) => Promise<any> }) => {
    const target = sspCallCount === 0 ? capturedDev : capturedRun;
    target.fn = opts.resolver;
    sspCallCount += 1;
    return async () => ({ props: {} });
  },
}));

const { mockResolveDev, mockResolvePageBySlug, mockGetActiveTunnel } = vi.hoisted(() => ({
  mockResolveDev: vi.fn<(...a: any[]) => Promise<any>>(),
  mockResolvePageBySlug: vi.fn<(...a: any[]) => Promise<any>>(),
  mockGetActiveTunnel: vi.fn<(...a: any[]) => Promise<any>>(),
}));
vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: {
    resolveDevPageBlockForAuthor: mockResolveDev,
    resolvePageBlockBySlug: mockResolvePageBySlug,
  },
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksDevTunnelEnabled: vi.fn(async () => true),
}));
vi.mock('~/server/services/blocks/dev-tunnel.service', () => ({
  getActiveDevTunnel: (...a: unknown[]) => mockGetActiveTunnel(...(a as [])),
}));
// Real dev-tunnel-session (pure) — signs a real token + validates the host.
vi.mock('~/env/server', () => ({ env: { APPS_DOMAIN: 'civit.ai' } }));
vi.mock('~/server/utils/server-domain', () => ({ ratingAllowedOnHost: () => true }));

// Heavy component deps stubbed so importing the page modules doesn't pull a DOM.
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
vi.mock('~/components/AppBlocks/useBlockToken', () => ({ useBlockToken: () => ({}) }));
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

const SECRET = 'test-nextauth-secret-dddddddddddddddddddd';
const DEV_APP = {
  appBlockId: 'apb_dev',
  blockId: 'my-app',
  appId: 'appblk-my-app',
  status: 'pending',
  trustTier: 'unverified' as const,
  name: 'My App',
  pageTitle: 'My App',
  sandbox: 'allow-scripts',
  scopes: [] as string[],
  contentRating: null,
};

function makeCtx(opts: { user?: any; blockId?: string; setHeader: (k: string, v: string) => void }) {
  return {
    features: { appBlocks: true, appBlocksAuthor: true },
    session: opts.user ? { user: opts.user } : null,
    ctx: {
      params: { blockId: opts.blockId ?? 'my-app' },
      resolvedUrl: '/apps/dev/my-app',
      req: { headers: { host: 'civitai.com' } },
      res: { setHeader: opts.setHeader },
    },
  };
}

async function loadDevResolver() {
  await import('~/pages/apps/dev/[blockId]');
  if (!capturedDev.fn) throw new Error('dev resolver not captured');
  return capturedDev.fn;
}
async function loadRunResolver() {
  await import('~/pages/apps/run/[slug]/[[...path]]');
  if (!capturedRun.fn) throw new Error('run resolver not captured');
  return capturedRun.fn;
}

const AUTHOR = { id: 555, username: 'dev', isModerator: false };

describe('/apps/dev/[blockId] SSR resolver', () => {
  const prev = process.env.NEXTAUTH_SECRET;
  beforeEach(() => {
    process.env.NEXTAUTH_SECRET = SECRET;
    mockResolveDev.mockReset();
    mockGetActiveTunnel.mockReset();
  });

  it('author + owner + active tunnel → iframeSrc set (server-derived host) + route-scoped CSP', async () => {
    const resolver = await loadDevResolver();
    mockResolveDev.mockResolvedValue(DEV_APP);
    mockGetActiveTunnel.mockResolvedValue({
      sessionId: 'bki_s',
      userId: 555,
      blockId: 'my-app',
      host: 'dev-0123456789abcdef.civit.ai',
      hardExpiresAt: 9e9,
      spendCapBuzz: 5000,
    });
    const headers: Record<string, string> = {};
    const res = await resolver(
      makeCtx({ user: AUTHOR, setHeader: (k, v) => (headers[k] = v) })
    );
    expect(res.props.iframeSrc).toMatch(
      /^https:\/\/dev-0123456789abcdef\.civit\.ai\/\?dev=[^&]+$/
    );
    // ROUTE-SCOPED CSP: frame-src pinned to the exact dev host, on THIS response.
    expect(headers['Content-Security-Policy']).toBe(
      'frame-src https://dev-0123456789abcdef.civit.ai'
    );
    expect(headers['Content-Security-Policy']).toContain('dev-');
  });

  it('no active tunnel → props with iframeSrc:null (renders "start your tunnel"), no CSP', async () => {
    const resolver = await loadDevResolver();
    mockResolveDev.mockResolvedValue(DEV_APP);
    mockGetActiveTunnel.mockResolvedValue(null);
    const headers: Record<string, string> = {};
    const res = await resolver(makeCtx({ user: AUTHOR, setHeader: (k, v) => (headers[k] = v) }));
    expect(res.props.iframeSrc).toBeNull();
    expect(headers['Content-Security-Policy']).toBeUndefined();
  });

  it('T6: a FOREIGN/invalid tunnel host is never reflected into iframeSrc', async () => {
    const resolver = await loadDevResolver();
    mockResolveDev.mockResolvedValue(DEV_APP);
    // A poisoned session host (attacker-shaped) must fail isValidDevHost → no src.
    mockGetActiveTunnel.mockResolvedValue({
      sessionId: 'bki_s',
      userId: 555,
      blockId: 'my-app',
      host: 'evil.com/../dev-0123456789abcdef.civit.ai',
      hardExpiresAt: 9e9,
      spendCapBuzz: 5000,
    });
    const headers: Record<string, string> = {};
    const res = await resolver(makeCtx({ user: AUTHOR, setHeader: (k, v) => (headers[k] = v) }));
    expect(res.props.iframeSrc).toBeNull();
    expect(headers['Content-Security-Policy']).toBeUndefined();
  });

  it('unauthenticated → redirect to login', async () => {
    const resolver = await loadDevResolver();
    const res = await resolver(makeCtx({ user: undefined, setHeader: () => {} }));
    expect(res.redirect?.destination).toContain('/login');
  });

  it('non-owner (resolver returns null) → notFound', async () => {
    const resolver = await loadDevResolver();
    mockResolveDev.mockResolvedValue(null);
    const res = await resolver(makeCtx({ user: AUTHOR, setHeader: () => {} }));
    expect(res.notFound).toBe(true);
  });

  it('author capability missing → notFound (fail-closed)', async () => {
    const resolver = await loadDevResolver();
    const res = await resolver({
      features: { appBlocks: true, appBlocksAuthor: false },
      session: { user: AUTHOR },
      ctx: {
        params: { blockId: 'my-app' },
        resolvedUrl: '/apps/dev/my-app',
        req: { headers: { host: 'civitai.com' } },
        res: { setHeader: () => {} },
      },
    });
    expect(res.notFound).toBe(true);
  });

  it('GLOBAL CSP unchanged: the /apps/run resolver sets NO Content-Security-Policy', async () => {
    const runResolver = await loadRunResolver();
    mockResolvePageBySlug.mockResolvedValue({
      appBlockId: 'ab',
      blockId: 'cool',
      appId: 'app',
      iframeSrc: 'https://cool.civit.ai',
      sandbox: 'allow-scripts',
      trustTier: 'unverified',
      name: 'Cool',
      pageTitle: 'Cool',
      scopes: [],
      contentRating: 'g',
    });
    const headers: Record<string, string> = {};
    await runResolver({
      features: { appBlocks: true, appBlocksPages: true },
      ctx: {
        params: { slug: 'cool' },
        req: { headers: { host: 'civitai.com' } },
        res: { setHeader: (k: string, v: string) => (headers[k] = v) },
      },
    });
    // The dev route sets a frame-src CSP; the run route must NOT — proving the
    // dev route's CSP is route-scoped and never widens the global CSP.
    expect(headers['Content-Security-Policy']).toBeUndefined();
  });
});
