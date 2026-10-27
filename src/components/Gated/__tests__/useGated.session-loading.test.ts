// @vitest-environment happy-dom
/**
 * `useGated` on the mature-content site, driven by the REAL SessionProvider through the session
 * transitions a shell page goes through. While the session is not known, above-PG content must
 * wait (`loading`), never show the login gate to a viewer who turns out to be signed in.
 *
 * Only the gate's other inputs are stubbed: the site allows mature content, there is no verified
 * bot, and the current user is the session's user, as `CivitaiSessionProvider` derives it.
 */
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSeed } from '~/providers/SessionProvider';
import type * as NextRouterModule from 'next/router';
import type * as UseCurrentUserModule from '~/hooks/useCurrentUser';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as AppProviderModule from '~/providers/AppProvider';
import type { Session } from '~/types/session';

vi.mock('next/router', async (importOriginal) => ({
  ...(await importOriginal<typeof NextRouterModule>()),
  useRouter: () => ({ asPath: '/images/1', query: {}, pathname: '/images/[imageId]' }),
}));
vi.mock('~/hooks/useCurrentUser', async (importOriginal) => {
  const { useSession } = await import('~/providers/SessionProvider');
  return {
    ...(await importOriginal<typeof UseCurrentUserModule>()),
    useCurrentUser: () => useSession().data?.user ?? null,
  };
});
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({ canViewNsfw: true }),
}));
vi.mock('~/providers/AppProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof AppProviderModule>()),
  useAppContext: () => ({ verifiedBot: null, allowMatureContent: true, domain: 'red' }),
}));

const { useGated } = await import('~/components/Gated/Gated');
const { SessionProvider } = await import('~/providers/SessionProvider');

const act = (React as unknown as { act: typeof actType }).act;

// NsfwLevel.PG13 and NsfwLevel.R, as literals.
const PG13 = 2;
const R = 4;
const SIGNED_IN = {
  user: { id: 41, username: 'seeded' },
  expires: '2099-01-01',
} as unknown as Session;

let pending: ((res: Response) => void)[] = [];
let root: Root | undefined;
/** The gate's state at every commit, per content level. */
let states: Record<number, string[]> = {};

function Probe({ level }: { level: number }) {
  const { state } = useGated({ contentNsfwLevel: level });
  React.useEffect(() => {
    (states[level] ??= []).push(state);
  });
  return null;
}

beforeEach(() => {
  pending = [];
  states = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          pending.push(resolve);
        })
    )
  );
  vi.spyOn(window, 'location', 'get').mockReturnValue({
    ...window.location,
    reload: vi.fn(),
  } as unknown as Location);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(seed: SessionSeed | null) {
  const tree = React.createElement(
    SessionProvider,
    { session: undefined, seed } as never,
    React.createElement(Probe, { level: PG13 }),
    React.createElement(Probe, { level: R })
  );
  if (!root) root = createRoot(document.createElement('div'));
  await act(async () => {
    root!.render(tree);
  });
}

async function answer(index: number, res: Response) {
  await vi.waitFor(() => expect(pending.length).toBeGreaterThan(index));
  await act(async () => {
    pending[index](res);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const lastState = (level: number) => states[level]?.[states[level].length - 1];

describe('useGated while the session is unknown, on the mature-content site', () => {
  it.each([
    ['PG13', PG13],
    ['R', R],
  ])('%s content waits while a seed is on its way', async (_, level) => {
    await render(null);
    expect(lastState(level)).toBe('loading');
  });

  it.each([
    ['PG13', PG13],
    ['R', R],
  ])(
    '%s: a failed focus refetch before the seed, then the seed — loading, then the page',
    async (_, level) => {
      await render(null);
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
      });
      await answer(0, new Response('', { status: 502 }));
      expect(lastState(level)).toBe('loading');

      await render({ session: SIGNED_IN });
      expect(lastState(level)).toBe('page');
      expect(states[level]).not.toContain('login');
    }
  );

  it.each([
    ['PG13', PG13],
    ['R', R],
  ])('%s: an unknown seed, then the fetched session — loading, then the page', async (_, level) => {
    await render(null);
    await render({ session: undefined });
    expect(lastState(level)).toBe('loading');

    await answer(0, new Response(JSON.stringify(SIGNED_IN), { status: 200 }));
    expect(lastState(level)).toBe('page');
    expect(states[level]).not.toContain('login');
  });

  it('control: a signed-out seed shows the login gate for above-PG content', async () => {
    await render(null);
    await render({ session: null });
    expect(lastState(PG13)).toBe('login');
    expect(lastState(R)).toBe('login');
  });
});
