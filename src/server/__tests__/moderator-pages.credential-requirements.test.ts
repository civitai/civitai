import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GetServerSidePropsContext } from 'next';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// `createServerSideProps`, the SSG helper and `getServerAuthSession` are deliberately unmocked:
// the rule reads the credential the session layer records on the request.
const { hubSession, bearerSession, moderatorQuery } = vi.hoisted(() => ({
  hubSession: { current: null as null | { user: Record<string, unknown> } },
  bearerSession: vi.fn(),
  moderatorQuery: vi.fn(async () => 'moderator-data'),
}));

vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: bearerSession }));
vi.mock('~/server/auth/session-client', () => ({
  getHubSession: vi.fn(async () => hubSession.current),
  maybeRollHubCookie: vi.fn(async () => undefined),
  maybeUpgradeLegacySession: vi.fn(async () => undefined),
  sessionClient: { getSessionUserById: vi.fn(async () => null) },
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlagsAsync: vi.fn(async () => ({})),
}));
// The full router tree is not needed: one procedure built from the real `moderatorProcedure`.
vi.mock('~/server/routers', async () => {
  const { moderatorProcedure, router } = await import('~/server/trpc');
  return { appRouter: router({ probe: moderatorProcedure.query(moderatorQuery) }) };
});

const { createServerSideProps } = await import('~/server/utils/server-side-helpers');

type Ssg = { probe: { prefetch: () => Promise<void> } };
const page = (requireModerator: boolean, prefetch: 'once' | 'always' = 'once') =>
  createServerSideProps({
    useSSG: true,
    requireModerator,
    prefetch,
    resolver: async ({ ssg }) => {
      if (ssg) await (ssg as unknown as Ssg).probe.prefetch();
      return { props: { rendered: true } };
    },
  });
const moderatorPage = page(true);
const openPage = page(false);
const openPageAlwaysPrefetching = page(false, 'always');

const MODERATOR = { id: 4242, username: 'mod', isModerator: true, bannedAt: null };
const MEMBER = { ...MODERATOR, isModerator: false };
const OTHER_USER = { id: 777, username: 'other', isModerator: false, bannedAt: null };

const nonOauthKey = (apiKeyType: string | undefined, tokenScope: number) => ({
  user: MODERATOR,
  apiKeyId: 11,
  ...(apiKeyType ? { apiKeyType } : {}),
  subject: { type: 'apiKey', id: 11 },
  tokenScope,
  buzzLimit: null,
});
const oauthToken = (tokenScope: number) => ({
  user: MODERATOR,
  apiKeyId: 12,
  apiKeyType: 'Access',
  subject: { type: 'oauth', id: 'client-abc' },
  tokenScope,
  buzzLimit: null,
});

const PATH = '/moderator/probe';
const CLIENT_NAV_PATH = '/_next/data/build-id/moderator/probe.json';

/** `seededSession` is what `_app` puts on `req.session` from its own settings request, which
 *  carries the same headers. */
function load(
  handler: typeof moderatorPage,
  {
    authorization,
    queryToken,
    path = PATH,
  }: { authorization?: string; queryToken?: string; path?: string } = {},
  seededSession?: { user: Record<string, unknown> }
) {
  const url = queryToken ? `${path}?token=${queryToken}` : path;
  return handler({
    req: {
      ...(seededSession ? { session: seededSession } : {}),
      url,
      headers: { host: 'civitai.com', ...(authorization ? { authorization } : {}) },
      cookies: {},
    },
    res: { setHeader: vi.fn(), getHeader: vi.fn() },
    query: queryToken ? { token: queryToken } : {},
    resolvedUrl: queryToken ? `${PATH}?token=${queryToken}` : PATH,
  } as unknown as GetServerSidePropsContext) as Promise<{
    props?: {
      rendered?: boolean;
      trpcState?: unknown;
      session?: { user?: { id?: number } } | null;
    };
    redirect?: { destination: string };
  }>;
}

const REDUCED = TokenScope.Full & ~TokenScope.AIServicesWrite;

const refusedBearers: [string, Record<string, unknown>][] = [
  ['a full-scope OAuth access token', oauthToken(TokenScope.Full)],
  ['a read-scope OAuth access token', oauthToken(TokenScope.UserRead)],
  ['a full-scope System key', nonOauthKey('System', TokenScope.Full)],
  ['a reduced-scope personal API key', nonOauthKey('User', REDUCED)],
  ['a key whose type was not recorded', nonOauthKey(undefined, TokenScope.Full)],
];

beforeEach(() => {
  vi.clearAllMocks();
  hubSession.current = null;
  bearerSession.mockResolvedValue(null);
});

describe('a page with requireModerator', () => {
  it('renders for a moderator browser session, with the prefetched data', async () => {
    hubSession.current = { user: MODERATOR };
    const result = await load(moderatorPage);
    expect(result.props?.rendered).toBe(true);
    expect(JSON.stringify(result.props?.trpcState)).toContain('moderator-data');
    expect(moderatorQuery).toHaveBeenCalledTimes(1);
  });

  it('renders for a moderator personal API key holding the full scope', async () => {
    bearerSession.mockResolvedValue(nonOauthKey('User', TokenScope.Full));
    const result = await load(moderatorPage, { authorization: 'Bearer personal-full' });
    expect(result.props?.rendered).toBe(true);
    expect(moderatorQuery).toHaveBeenCalledTimes(1);
  });

  it.each(refusedBearers)('redirects a moderator presenting %s', async (_label, session) => {
    bearerSession.mockResolvedValue(session);
    const result = await load(moderatorPage, { authorization: 'Bearer token' });
    expect(result).toEqual({ redirect: { destination: '/', permanent: false } });
    expect(moderatorQuery).not.toHaveBeenCalled();
  });

  it('redirects a token passed in the query string, even a full-scope personal key', async () => {
    bearerSession.mockResolvedValue(nonOauthKey('User', TokenScope.Full));
    const result = await load(moderatorPage, { queryToken: 'personal-full' });
    expect(result).toEqual({ redirect: { destination: '/', permanent: false } });
    expect(moderatorQuery).not.toHaveBeenCalled();
  });

  it('renders for a full-scope personal API key on a request with a seeded session', async () => {
    bearerSession.mockResolvedValue(nonOauthKey('User', TokenScope.Full));
    const result = await load(
      moderatorPage,
      { authorization: 'Bearer personal-full' },
      { user: MODERATOR }
    );
    expect(result.props?.rendered).toBe(true);
    expect(moderatorQuery).toHaveBeenCalledTimes(1);
  });

  it('renders for a moderator browser session on a client-side navigation', async () => {
    hubSession.current = { user: MODERATOR };
    const result = await load(moderatorPage, { path: CLIENT_NAV_PATH });
    expect(result.props?.rendered).toBe(true);
  });

  it('sends a signed-in visitor whose query-string token resolves to nothing home', async () => {
    hubSession.current = { user: MODERATOR };
    const result = await load(moderatorPage, { queryToken: 'not-a-key' }, { user: MODERATOR });
    expect(result).toEqual({ redirect: { destination: '/', permanent: false } });
    expect(moderatorQuery).not.toHaveBeenCalled();
  });

  it('sends a visitor whose Authorization header resolves to nothing home', async () => {
    const result = await load(moderatorPage, { authorization: 'Bearer not-a-key' });
    expect(result).toEqual({ redirect: { destination: '/', permanent: false } });
    expect(moderatorQuery).not.toHaveBeenCalled();
  });

  it.each(refusedBearers)(
    'redirects a moderator presenting %s on a request with a seeded session',
    async (_label, session) => {
      bearerSession.mockResolvedValue(session);
      const result = await load(
        moderatorPage,
        { authorization: 'Bearer token' },
        { user: MODERATOR }
      );
      expect(result).toEqual({ redirect: { destination: '/', permanent: false } });
      expect(moderatorQuery).not.toHaveBeenCalled();
    }
  );

  it('redirects a non-moderator session', async () => {
    hubSession.current = { user: MEMBER };
    expect(await load(moderatorPage)).toEqual({ redirect: { destination: '/', permanent: false } });
    expect(moderatorQuery).not.toHaveBeenCalled();
  });

  it('sends a signed-out visitor to login', async () => {
    const result = await load(moderatorPage);
    expect(result.redirect?.destination).toBe(`/login?returnUrl=${encodeURIComponent(PATH)}`);
    expect(moderatorQuery).not.toHaveBeenCalled();
  });
});

describe('a moderator procedure prefetched by a page without requireModerator', () => {
  it('runs for a moderator browser session', async () => {
    hubSession.current = { user: MODERATOR };
    const result = await load(openPage);
    expect(JSON.stringify(result.props?.trpcState)).toContain('moderator-data');
    expect(moderatorQuery).toHaveBeenCalledTimes(1);
  });

  it('runs for a moderator session seeded on the request', async () => {
    const result = await load(openPage, {}, { user: MODERATOR });
    expect(JSON.stringify(result.props?.trpcState)).toContain('moderator-data');
    expect(moderatorQuery).toHaveBeenCalledTimes(1);
  });

  it('runs for a moderator personal API key holding the full scope', async () => {
    bearerSession.mockResolvedValue(nonOauthKey('User', TokenScope.Full));
    const result = await load(openPage, { authorization: 'Bearer personal-full' });
    expect(JSON.stringify(result.props?.trpcState)).toContain('moderator-data');
    expect(moderatorQuery).toHaveBeenCalledTimes(1);
  });

  it('runs for a full-scope personal API key on a client-side navigation', async () => {
    bearerSession.mockResolvedValue(nonOauthKey('User', TokenScope.Full));
    const result = await load(openPageAlwaysPrefetching, {
      authorization: 'Bearer personal-full',
      path: CLIENT_NAV_PATH,
    });
    expect(JSON.stringify(result.props?.trpcState)).toContain('moderator-data');
    expect(moderatorQuery).toHaveBeenCalledTimes(1);
  });

  it.each(refusedBearers)(
    'does not run for a moderator presenting %s on a request with a seeded session',
    async (_label, session) => {
      bearerSession.mockResolvedValue(session);
      const result = await load(openPage, { authorization: 'Bearer token' }, { user: MODERATOR });
      expect(result.props?.rendered).toBe(true);
      expect(JSON.stringify(result.props?.trpcState)).not.toContain('moderator-data');
      expect(moderatorQuery).not.toHaveBeenCalled();
    }
  );

  it('runs as the seeded moderator session when the query string carries a token', async () => {
    bearerSession.mockResolvedValue(oauthToken(TokenScope.Full));
    const result = await load(openPage, { queryToken: 'oauth-access' }, { user: MODERATOR });
    expect(JSON.stringify(result.props?.trpcState)).toContain('moderator-data');
    expect(moderatorQuery).toHaveBeenCalledTimes(1);
    expect(bearerSession).not.toHaveBeenCalled();
  });

  it.each(refusedBearers)('does not run for a moderator presenting %s', async (_label, session) => {
    bearerSession.mockResolvedValue(session);
    const result = await load(openPage, { authorization: 'Bearer token' });
    expect(result.props?.rendered).toBe(true);
    expect(JSON.stringify(result.props?.trpcState)).not.toContain('moderator-data');
    expect(moderatorQuery).not.toHaveBeenCalled();
  });
});

describe('a page with requireModerator and a query-string token', () => {
  it('sends a signed-out visitor home when the token resolves to nothing', async () => {
    const result = await load(moderatorPage, { queryToken: 'not-a-key' });
    expect(result).toEqual({ redirect: { destination: '/', permanent: false } });
    expect(moderatorQuery).not.toHaveBeenCalled();
  });
});

describe('the session a page renders with', () => {
  it("stays the seeded member when the query string carries another account's key", async () => {
    bearerSession.mockResolvedValue({ ...nonOauthKey('User', TokenScope.Full), user: OTHER_USER });
    const result = await load(openPage, { queryToken: 'other-key' }, { user: MEMBER });
    expect(result.props?.session?.user?.id).toBe(MEMBER.id);
    expect(bearerSession).not.toHaveBeenCalled();
  });

  it('stays the seeded member when the query-string token resolves to nothing', async () => {
    const result = await load(openPage, { queryToken: 'not-a-key' }, { user: MEMBER });
    expect(result.props?.session?.user?.id).toBe(MEMBER.id);
  });

  it("is the Authorization header's account, not the seeded one", async () => {
    bearerSession.mockResolvedValue({ ...nonOauthKey('User', TokenScope.Full), user: OTHER_USER });
    const result = await load(openPage, { authorization: 'Bearer other-key' }, { user: MEMBER });
    expect(result.props?.session?.user?.id).toBe(OTHER_USER.id);
    expect(bearerSession).toHaveBeenCalledTimes(1);
  });
});
