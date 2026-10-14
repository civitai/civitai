import type { IncomingMessage } from 'http';
import type { GetServerSidePropsContext } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';

/**
 * An SSR render resolves its request's feature flags in `_app` getInitialProps and again in
 * `createServerSideProps`. Both must be served by ONE evaluation per request: the shared
 * cross-request cache can expire between the two calls, which used to re-run every flag
 * evaluation for the same request (and could hand the page different flags than `_app` sent the
 * client). Flag evaluations are counted at the Flipt boundary, the per-flag work each one does.
 */

const { flipt } = vi.hoisted(() => ({
  flipt: { ensureInit: vi.fn(async () => undefined), isFliptSync: vi.fn(() => null) },
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  ensureFliptInitialized: flipt.ensureInit,
  isFliptSync: flipt.isFliptSync,
}));
vi.mock('~/server/auth/session-client', () => ({
  getHubSession: vi.fn(async () => null),
  maybeRollHubCookie: vi.fn(async () => undefined),
  maybeUpgradeLegacySession: vi.fn(async () => undefined),
  sessionClient: { getSessionUserById: vi.fn(async () => null) },
}));
vi.mock('~/server/routers', async () => {
  const { router } = await import('~/server/trpc');
  return { appRouter: router({}) };
});

const { getFeatureFlagsAsync } = await import('~/server/services/feature-flags.service');
const { createServerSideProps } = await import('~/server/utils/server-side-helpers');

const HOST = 'civitai.com';
const USER = { id: 4242, username: 'ivy', isModerator: false, bannedAt: null } as never;
const OTHER_USER = { id: 777, username: 'rowan', isModerator: true, bannedAt: null } as never;

const page = createServerSideProps({ resolver: async () => ({ props: {} }) });

const newRequest = (session: unknown) =>
  ({ url: '/models/1', headers: { host: HOST }, session } as unknown as IncomingMessage);

const runPage = (req: IncomingMessage) =>
  page({
    req,
    res: {},
    query: {},
    resolvedUrl: '/models/1',
  } as unknown as GetServerSidePropsContext);

// What `_app` getInitialProps asks for, verbatim in shape.
const appFlags = (req: IncomingMessage, user = USER) =>
  getFeatureFlagsAsync({ user, host: req.headers.host, req });

let now = 1_000_000_000_000;

beforeEach(() => {
  now += 60_000; // past the shared cache's TTL, so every test starts cold
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  flipt.ensureInit.mockClear();
  flipt.isFliptSync.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SSR feature flags are evaluated once per request', () => {
  it('createServerSideProps reuses the flags _app resolved, even after the shared cache expired', async () => {
    const req = newRequest({ user: USER });

    const fromApp = await appFlags(req);
    const evaluationsAfterApp = flipt.isFliptSync.mock.calls.length;
    expect(evaluationsAfterApp, 'the counter must see the first evaluation').toBeGreaterThan(0);

    now += 11_000; // the shared cache entry has expired by the time the page props run
    const result = await runPage(req);

    expect('props' in result).toBe(true);
    expect(flipt.isFliptSync.mock.calls.length).toBe(evaluationsAfterApp);
    expect(flipt.ensureInit).toHaveBeenCalledTimes(1);
    expect(await getFeatureFlagsAsync({ user: USER, req })).toEqual(fromApp);
  });

  it('control: a different request evaluates on its own', async () => {
    await appFlags(newRequest({ user: USER }));
    const first = flipt.isFliptSync.mock.calls.length;

    now += 11_000;
    await appFlags(newRequest({ user: USER }));

    expect(flipt.isFliptSync.mock.calls.length).toBe(first * 2);
  });

  it('a request that resolves a different user gets that user’s own evaluation', async () => {
    const req = newRequest({ user: USER });
    const forUser = await appFlags(req);
    const first = flipt.isFliptSync.mock.calls.length;

    const forOther = await appFlags(req, OTHER_USER);

    expect(flipt.isFliptSync.mock.calls.length).toBeGreaterThan(first);
    expect(forOther).toEqual(await getFeatureFlagsAsync({ user: OTHER_USER, req }));
    expect(forOther).not.toEqual(forUser);
  });

  it('hands every caller its own copy', async () => {
    const req = newRequest({ user: USER });
    const a = await appFlags(req);
    (a as Record<string, unknown>).canViewNsfw = 'mutated';

    const b = await appFlags(req);

    expect(b).not.toBe(a);
    expect((b as Record<string, unknown>).canViewNsfw).not.toBe('mutated');

    // b came from the memo: mutating it must not reach the next caller either.
    (b as Record<string, unknown>).canViewNsfw = 'mutated-again';
    const c = await appFlags(req);
    expect((c as Record<string, unknown>).canViewNsfw).not.toBe('mutated-again');
  });
});
