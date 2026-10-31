import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DevTunnelFrameService from '~/server/services/blocks/dev-tunnel-frame.service';

/**
 * APP DEV TUNNEL — `/apps/dev/[blockId]` SSR resolver.
 *
 *   - author + owner + flags + active tunnel → iframeSrc = https://<dev-host>/?dev=<token>
 *     (server-derived host ONLY; strict `dev-<16hex>` shape) + a route-scoped CSP
 *     (pinned by the two CSP cases below).
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

const { mockResolveDev, mockResolvePageBySlug, mockGetActiveTunnel, mockUnsubmittedSpend } =
  vi.hoisted(() => ({
    mockResolveDev: vi.fn<(...a: any[]) => Promise<any>>(),
    mockResolvePageBySlug: vi.fn<(...a: any[]) => Promise<any>>(),
    mockGetActiveTunnel: vi.fn<(...a: any[]) => Promise<any>>(),
    mockUnsubmittedSpend: vi.fn<(...a: any[]) => Promise<boolean>>(async () => true),
  }));
vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: {
    resolveDevPageBlockForAuthor: mockResolveDev,
    resolvePageBlockBySlug: mockResolvePageBySlug,
  },
}));
const { mockDevTunnelEnabled, mockResolveFrame, mockHostPublished } = vi.hoisted(() => ({
  mockHostPublished: vi.fn<(host: string) => Promise<boolean>>(async () => true),
  mockDevTunnelEnabled: vi.fn<(...a: unknown[]) => Promise<boolean>>(async () => true),
  mockResolveFrame: vi.fn(),
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksDevTunnelEnabled: (...a: unknown[]) => mockDevTunnelEnabled(...a),
  isAppBlocksDevTunnelUnsubmittedSpendEnabled: (...a: unknown[]) =>
    mockUnsubmittedSpend(...(a as [])),
}));
// The real resolver, observed: a spy that delegates, so a call can be asserted absent.
vi.mock('~/server/services/blocks/dev-tunnel-frame.service', async (importOriginal) => {
  const real = await importOriginal<typeof DevTunnelFrameService>();
  mockResolveFrame.mockImplementation(real.resolveDevTunnelFrame);
  return { ...real, resolveDevTunnelFrame: mockResolveFrame };
});
vi.mock('~/server/services/blocks/dev-tunnel.service', () => ({
  getActiveDevTunnel: (...a: unknown[]) => mockGetActiveTunnel(...(a as [])),
}));
vi.mock('~/server/services/blocks/dev-tunnel-dns.service', () => ({
  isDevTunnelHostPublished: (host: string) => mockHostPublished(host),
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
vi.mock('~/components/AppBlocks/DevTunnelDnsGate', () => ({ DevTunnelDnsGate: () => null }));
vi.mock('~/components/AppBlocks/useBlockToken', () => ({ useBlockToken: () => ({}) }));
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

// The Retry endpoint (`/api/apps/dev/entry-url`), for the parity cases at the end: its wrapper
// hands it the session user, and its feature flags are the ones each case gives the page.
const { endpointFeatures } = vi.hoisted(() => ({
  endpointFeatures: { current: {} as Record<string, boolean> },
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  AuthedEndpoint:
    (handler: (req: unknown, res: unknown, user: unknown) => Promise<unknown>) =>
    (req: unknown, res: unknown) =>
      handler(req, res, { id: 555, username: 'dev', isModerator: false }),
}));
vi.mock('~/server/utils/require-full-scope-session', () => ({
  requireFullScopeSession: () => true,
}));
vi.mock('~/server/services/feature-flags.service', () => ({
  getFeatureFlagsAsync: async () => endpointFeatures.current,
}));

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

const AUTHOR = { id: 555, username: 'dev', isModerator: false };

/** An active tunnel session owned by `AUTHOR`, parameterised on `host` because
 *  that is the field the CSP cases vary.
 *
 *  🔴 A PARTIAL fixture, not the real record shape: the resolver reads only
 *  `tunnel.host` and `tunnel.grantedScopes`, so the rest of
 *  `DevTunnelSessionRecord` is omitted — including `fingerprint` and `createdAt`,
 *  which that type REQUIRES. It passes only because `mockGetActiveTunnel` is
 *  loosely typed. Add the missing fields before reusing this on any path that
 *  reads them.
 *
 *  `userId` and `blockId` match the caller (`AUTHOR.id`, `'my-app'`) because the
 *  REAL `getActiveDevTunnel` returns a record only when BOTH equal its arguments,
 *  fail-closed (`src/server/services/blocks/dev-tunnel.service.ts`, the ownership
 *  cross-check; `stopDevTunnel` guards on `userId` the same way). That service is
 *  mocked here, so the cross-check never runs and these cases exercise no
 *  ownership behaviour — they would pass with any values. Keep them consistent
 *  anyway: an inconsistent pair is a record production can never return.
 *
 *  `grantedScopes` is omitted, representing a session with no declared scopes —
 *  and it must STAY omitted: both CSP cases forward the resulting `undefined` to
 *  a mocked `resolveDevPageBlockForAuthor` and neither asserts the argument, so
 *  adding it here to make the fixture "more realistic" would silently change
 *  what those cases forward. */
const activeTunnel = (host: string) => ({
  sessionId: 'bki_s',
  userId: AUTHOR.id,
  blockId: 'my-app',
  host,
  hardExpiresAt: 9e9,
  spendCapBuzz: 5000,
});

function makeCtx(opts: {
  user?: any;
  blockId?: string;
  setHeader: (k: string, v: string) => void;
}) {
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

describe('/apps/dev/[blockId] SSR resolver', () => {
  const prev = process.env.NEXTAUTH_SECRET;
  beforeEach(() => {
    process.env.NEXTAUTH_SECRET = SECRET;
    mockResolveDev.mockReset();
    mockGetActiveTunnel.mockReset();
    mockUnsubmittedSpend.mockReset();
    mockUnsubmittedSpend.mockResolvedValue(true);
    mockDevTunnelEnabled.mockReset();
    mockDevTunnelEnabled.mockResolvedValue(true);
    mockResolveFrame.mockClear();
    mockHostPublished.mockReset();
    mockHostPublished.mockResolvedValue(true);
  });

  it('kill switch off → notFound before anything is resolved or signed, and no CSP', async () => {
    const resolver = await loadDevResolver();
    mockDevTunnelEnabled.mockResolvedValue(false);
    mockResolveDev.mockResolvedValue(DEV_APP);
    mockGetActiveTunnel.mockResolvedValue(activeTunnel('dev-0123456789abcdef.civit.ai'));
    const headers: Record<string, string> = {};
    const res = await resolver(makeCtx({ user: AUTHOR, setHeader: (k, v) => (headers[k] = v) }));
    expect(res).toEqual({ notFound: true });
    expect(mockDevTunnelEnabled).toHaveBeenCalledWith({ user: AUTHOR });
    expect(mockResolveFrame).not.toHaveBeenCalled();
    expect(mockGetActiveTunnel).not.toHaveBeenCalled();
    expect(headers).toEqual({});
  });

  it('POSITIVE CONTROL: with the kill switch on, the same request resolves the frame', async () => {
    const resolver = await loadDevResolver();
    mockResolveDev.mockResolvedValue(DEV_APP);
    mockGetActiveTunnel.mockResolvedValue(activeTunnel('dev-0123456789abcdef.civit.ai'));
    await resolver(makeCtx({ user: AUTHOR, setHeader: () => undefined }));
    expect(mockResolveFrame).toHaveBeenCalledTimes(1);
  });
  afterAll(() => {
    process.env.NEXTAUTH_SECRET = prev;
  });

  it('author + owner + active tunnel → iframeSrc set (server-derived host) + route-scoped CSP', async () => {
    const resolver = await loadDevResolver();
    mockResolveDev.mockResolvedValue(DEV_APP);
    mockGetActiveTunnel.mockResolvedValue(activeTunnel('dev-0123456789abcdef.civit.ai'));
    const headers: Record<string, string> = {};
    const res = await resolver(makeCtx({ user: AUTHOR, setHeader: (k, v) => (headers[k] = v) }));
    expect(res.props.iframeSrc).toMatch(/^https:\/\/dev-0123456789abcdef\.civit\.ai\/\?dev=[^&]+$/);
    // ROUTE-SCOPED CSP: frame-src pinned to the exact dev host, plus
    // frame-ancestors 'none', on THIS response. Pinned as a WHOLE string — a
    // substring assertion would pass while a directive was dropped or widened.
    expect(headers['Content-Security-Policy']).toBe(
      "frame-src https://dev-0123456789abcdef.civit.ai; frame-ancestors 'none'"
    );
  });

  it('active tunnel whose host is not published yet → dnsPending, no entry URL or token in the props, and the CSP already names the host', async () => {
    const resolver = await loadDevResolver();
    mockResolveDev.mockResolvedValue(DEV_APP);
    mockGetActiveTunnel.mockResolvedValue(activeTunnel('dev-0123456789abcdef.civit.ai'));
    mockHostPublished.mockResolvedValue(false);
    const headers: Record<string, string> = {};
    const res = await resolver(makeCtx({ user: AUTHOR, setHeader: (k, v) => (headers[k] = v) }));
    expect(mockHostPublished).toHaveBeenCalledExactlyOnceWith('dev-0123456789abcdef.civit.ai');
    expect(res.props).toMatchObject({ iframeSrc: null, dnsPending: true });
    expect(JSON.stringify(res.props)).not.toContain('?dev=');
    // The page reaches the frame by a client-side transition once the host resolves, which
    // keeps THIS document's policy — so it has to allow the host already.
    expect(headers['Content-Security-Policy']).toBe(
      "frame-src https://dev-0123456789abcdef.civit.ai; frame-ancestors 'none'"
    );
  });

  /**
   * Why the CSP carries `frame-ancestors 'none'` rather than `'self'` is reasoned
   * out at the `setHeader` call in `src/pages/apps/dev/[blockId].tsx`. Do not
   * restate it here — two copies of one argument drift apart, and the source is
   * the copy a future editor reads. That argument is why the VALUE, rather than
   * the directive's mere presence, is what these assertions pin.
   *
   * 🔴 NEITHER THIS CASE NOR THE `toBe` ABOVE SUBSUMES THE OTHER. Keep both.
   * Measured, by mutating the header expression:
   *
   *   - hardcode the other test's host, in the CSP  →  `toBe` PASSES, this case
   *     fails. A single hardcoded-string assertion is structurally blind to
   *     interpolation. The `frame-src` assertion below is the ONLY assertion in
   *     this file that catches it. 🔴 Do not delete it as redundant with the
   *     `toBe` — it is the independence. (The `iframeSrc` assertion below also
   *     interpolates `host`, but off a SEPARATE expression, so it cannot see a
   *     hardcoded CSP host — and nothing else can see a hardcoded `iframeSrc`.)
   *   - append `default-src 'none'`, or swap the directive order  →  `toBe`
   *     fails, this case PASSES. The `toBe` is byte-exact, so it is the only
   *     thing that catches a THIRD directive — one under a name neither
   *     assertion below filters on — and an appended `default-src 'none'` would
   *     break this page. (Among ADDED directives, a DUPLICATE of either named
   *     directive dies in both cases and only a new name slips past this one;
   *     an order swap, a trailing `;` and inter-directive whitespace also pass
   *     here, being invisible to a directive-set assertion.)
   *
   * Within the directives it does name, this case asserts the SET rather than
   * checking a word is present. `'self'` is one spelling of a widening;
   * `frame-ancestors https://evil.example; frame-ancestors 'none'` is another,
   * and per CSP a duplicated directive keeps the FIRST occurrence and discards
   * the rest — so that policy is framable by an arbitrary origin while any
   * "contains 'none', not 'self'" check prints green. Asserting the filtered list
   * is exactly one entry covers `'self'`, `*`, a foreign origin AND the duplicate
   * shape in one claim.
   *
   * Both directives get that treatment deliberately: `frame-src` is subject to
   * the identical duplicate-directive hazard, and it is the directive that
   * permits the dev iframe — a policy whose first `frame-src` is a foreign origin
   * both breaks the iframe and widens what this document may frame.
   */
  it('interpolates THIS host into both iframeSrc and the CSP, and pins each directive as an exact one-entry set', async () => {
    const resolver = await loadDevResolver();
    mockResolveDev.mockResolvedValue(DEV_APP);
    // Deliberately NOT the host the test above uses: distinct in every hex digit,
    // so a mutant that hardcodes that literal cannot survive here.
    const host = 'dev-fedcba9876543210.civit.ai';
    mockGetActiveTunnel.mockResolvedValue(activeTunnel(host));
    const headers: Record<string, string> = {};
    const res = await resolver(makeCtx({ user: AUTHOR, setHeader: (k, v) => (headers[k] = v) }));

    // `iframeSrc` is built from `host` by a SEPARATE expression from the CSP, and
    // the case above pins it with a hardcoded regex — so that case cannot tell an
    // interpolated host from a baked-in one either. Asserting it here, at the
    // second host, is what makes a hardcoded `iframeSrc` fail.
    expect(res.props.iframeSrc).toMatch(
      new RegExp(`^https://${host.replace(/\./g, '\\.')}/\\?dev=[^&]+$`)
    );

    const csp = headers['Content-Security-Policy'];
    // Guard the read, and narrow it: `expect(...).toBeDefined()` is not a TS
    // narrowing, so the `.split` below type-checks only while
    // `noUncheckedIndexedAccess` is off. A throw keeps this correct either way,
    // and names the missing header instead of failing as a TypeError on `.split`.
    if (typeof csp !== 'string') throw new Error(`no CSP header set; got ${String(csp)}`);
    const directives = csp.split(';').map((d) => d.trim());
    // Matched on the directive NAME, case-insensitively. CSP names are
    // case-insensitive, and the shape that buys is a case-variant duplicate
    // ordered FIRST — `FRAME-ANCESTORS 'self'; frame-ancestors 'none'`, which
    // first-occurrence-wins makes a real widening, and which a case-SENSITIVE
    // filter scores green because it only ever sees the `'none'` entry. (A
    // case-variant as the SOLE directive is caught either way: the filter
    // returns `[]` and the `toEqual` fails on that.) `(\s|$)` rather than `\b` —
    // a hyphen is a non-word character, so `\b` would also match a longer
    // hyphenated name like `frame-src-elem`.
    const directive = (name: string) =>
      directives.filter((d) => new RegExp(`^${name}(\\s|$)`, 'i').test(d));
    expect(directive('frame-ancestors')).toEqual(["frame-ancestors 'none'"]);
    expect(directive('frame-src')).toEqual([`frame-src https://${host}`]);
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
    mockGetActiveTunnel.mockResolvedValue(
      activeTunnel('evil.com/../dev-0123456789abcdef.civit.ai')
    );
    const headers: Record<string, string> = {};
    const res = await resolver(makeCtx({ user: AUTHOR, setHeader: (k, v) => (headers[k] = v) }));
    expect(res.props.iframeSrc).toBeNull();
    expect(headers['Content-Security-Policy']).toBeUndefined();
  });

  it('BRAND-NEW: passes the session grantedScopes + unsubmitted-spend flag into the resolver, and surfaces its scopes as declaredScopes', async () => {
    const resolver = await loadDevResolver();
    // The resolver (mocked) is the single scope authority — SSR just forwards the
    // session scopes + flag and reflects the returned `scopes` into the prop.
    mockResolveDev.mockResolvedValue({
      ...DEV_APP,
      status: 'ephemeral',
      scopes: ['ai:write:budgeted', 'user:read:self'],
      ephemeralSource: 'brand-new',
    });
    mockGetActiveTunnel.mockResolvedValue({
      ...activeTunnel('dev-0123456789abcdef.civit.ai'),
      grantedScopes: ['ai:write:budgeted', 'user:read:self'],
    });
    mockUnsubmittedSpend.mockResolvedValue(true);
    const res = await resolver(makeCtx({ user: AUTHOR, setHeader: () => {} }));
    // Resolver received the SESSION scopes (never a browser body) + the flag result.
    expect(mockResolveDev).toHaveBeenCalledWith(
      'my-app',
      555,
      expect.objectContaining({
        sessionGrantedScopes: ['ai:write:budgeted', 'user:read:self'],
        unsubmittedSpendAllowed: true,
      })
    );
    // The advertised declaredScopes prop == the resolver's returned scopes (so the
    // block's Generate gate matches what the mint will grant).
    expect(res.props.scopes).toEqual(['ai:write:budgeted', 'user:read:self']);
  });

  it('BRAND-NEW with the unsubmitted-spend flag OFF → forwards unsubmittedSpendAllowed:false', async () => {
    const resolver = await loadDevResolver();
    mockUnsubmittedSpend.mockResolvedValue(false);
    mockResolveDev.mockResolvedValue({
      ...DEV_APP,
      status: 'ephemeral',
      scopes: ['user:read:self'],
      ephemeralSource: 'brand-new',
    });
    mockGetActiveTunnel.mockResolvedValue({
      ...activeTunnel('dev-0123456789abcdef.civit.ai'),
      grantedScopes: ['ai:write:budgeted', 'user:read:self'],
    });
    const res = await resolver(makeCtx({ user: AUTHOR, setHeader: () => {} }));
    expect(mockResolveDev).toHaveBeenCalledWith(
      'my-app',
      555,
      expect.objectContaining({ unsubmittedSpendAllowed: false })
    );
    expect(res.props.scopes).toEqual(['user:read:self']);
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

/**
 * The page and its Retry endpoint (`/api/apps/dev/entry-url`) answer the SAME request the same way:
 * whatever the page refuses with `notFound`, the endpoint refuses with its one bare 404, and the
 * endpoint signs a URL only when the page would. A gate added to one and not the other fails here.
 * Both run the real gate chain; only its data sources are stubbed.
 */
describe('/apps/dev/[blockId] and its Retry endpoint apply the same gates', () => {
  const HOST = 'dev-0f1e2d3c4b5a6978.civit.ai';
  const prev = process.env.NEXTAUTH_SECRET;
  afterAll(() => {
    process.env.NEXTAUTH_SECRET = prev;
  });
  beforeEach(() => {
    process.env.NEXTAUTH_SECRET = SECRET;
    mockDevTunnelEnabled.mockReset().mockResolvedValue(true);
    mockResolveDev.mockReset().mockResolvedValue(DEV_APP);
    mockGetActiveTunnel.mockReset().mockResolvedValue(activeTunnel(HOST));
    mockHostPublished.mockReset().mockResolvedValue(true);
    mockUnsubmittedSpend.mockReset().mockResolvedValue(true);
  });

  async function both(features: Record<string, boolean>) {
    const resolver = await loadDevResolver();
    const page = await resolver({
      ...makeCtx({ user: AUTHOR, setHeader: () => undefined }),
      features,
    });
    endpointFeatures.current = features;
    const endpoint = (await import('~/pages/api/apps/dev/entry-url')).default as unknown as (
      req: unknown,
      res: unknown
    ) => Promise<void>;
    let status = 200;
    let body: any;
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

  const ON = { appBlocks: true, appBlocksAuthor: true };

  it.each([
    ['App Blocks off', { appBlocksAuthor: true }, () => undefined],
    ['the author capability off', { appBlocks: true }, () => undefined],
    ['the kill switch off', ON, () => mockDevTunnelEnabled.mockResolvedValue(false)],
    ['a block the caller does not own', ON, () => mockResolveDev.mockResolvedValue(null)],
  ])(
    '%s: the page is notFound and the endpoint the same bare 404',
    async (_n, features, arrange) => {
      arrange();
      const { page, endpoint } = await both(features);
      expect(page).toEqual({ notFound: true });
      expect(endpoint).toEqual({ status: 404, body: { error: 'App not found' } });
    }
  );

  it.each([
    ['no live tunnel', () => mockGetActiveTunnel.mockResolvedValue(null)],
    ['the host not published yet', () => mockHostPublished.mockResolvedValue(false)],
  ])('%s: neither signs an entry URL', async (_n, arrange) => {
    arrange();
    const { page, endpoint } = await both(ON);
    expect(page.props.iframeSrc).toBeNull();
    expect(endpoint.status).toBe(409);
    expect(JSON.stringify(endpoint.body)).not.toContain('?dev=');
  });

  it('POSITIVE CONTROL: with every gate open, both sign a URL on the same tunnel host', async () => {
    const { page, endpoint } = await both(ON);
    const shape = new RegExp(`^https://${HOST.replace(/\./g, '\\.')}/\\?dev=[^&]+$`);
    expect(page.props.iframeSrc).toMatch(shape);
    expect(endpoint.status).toBe(200);
    expect(endpoint.body).toEqual({ iframeSrc: expect.stringMatching(shape), host: HOST });
  });
});
