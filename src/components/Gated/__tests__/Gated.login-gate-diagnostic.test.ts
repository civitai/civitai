// @vitest-environment happy-dom
/**
 * `Gated`'s login-gate diagnostic (`~/utils/faro/loginGate`), driven by the REAL SessionProvider
 * and the real gate decision on the mature-content site: one Faro event when the login card shows
 * to a viewer whose hard load carried a session cookie, and none otherwise.
 *
 * Stubbed: the gate's other inputs (site allows mature content, no verified bot, the current user
 * is the session's user as `CivitaiSessionProvider` derives it), `<Meta>` (next/head) and the ad
 * gate, and the Faro global — initialised (`config` set), with `pushEvent` recorded.
 */
import * as React from 'react';
import { MantineProvider } from '@mantine/core';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSeed } from '~/providers/SessionProvider';
import type * as NextRouterModule from 'next/router';
import type * as UseCurrentUserModule from '~/hooks/useCurrentUser';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as AppProviderModule from '~/providers/AppProvider';
import type * as AdsProviderModule from '~/components/Ads/AdsProvider';
import type { Session } from '~/types/session';
import type { SessionCookieKind } from '~/shared/utils/session-cookie';

const h = vi.hoisted(() => ({
  pushEvent: vi.fn<(name: string, attributes: Record<string, string>) => void>(),
}));

vi.mock('@grafana/faro-web-sdk', () => ({
  faro: { config: {}, api: { pushEvent: h.pushEvent } },
}));
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
  useAppContext: () => ({
    verifiedBot: null,
    allowMatureContent: true,
    domain: { red: true, green: false, blue: false },
    serverDomains: {},
  }),
}));
vi.mock('~/components/Ads/AdsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof AdsProviderModule>()),
  useAdGate: () => undefined,
}));
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));

const { Gated } = await import('~/components/Gated/Gated');
const { SessionProvider, useSession } = await import('~/providers/SessionProvider');
const { resetLoginGateReportForTests } = await import('~/utils/faro/loginGate');

const act = (React as unknown as { act: typeof actType }).act;

// NsfwLevel.PG and NsfwLevel.R, as literals.
const PG = 1;
const R = 4;
const SIGNED_IN = {
  user: { id: 4141, username: 'gate-fixture-user', email: 'gate-fixture@example.test' },
  expires: '2099-01-01',
} as unknown as Session;

let pending: ((res: Response) => void)[] = [];
let root: Root | undefined;
let container: HTMLDivElement;
/** The provider's `update`, captured by `UpdateProbe`. */
let update: ((trigger?: 'refresh-signal') => Promise<unknown>) | undefined;

function UpdateProbe() {
  const current = useSession().update;
  React.useEffect(() => {
    update = current;
  });
  return null;
}

beforeEach(() => {
  resetLoginGateReportForTests();
  h.pushEvent.mockReset();
  pending = [];
  update = undefined;
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
  window.sessionStorage.clear();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type Mount = {
  session?: Session | null;
  seed?: SessionSeed | null;
  sessionCookie?: SessionCookieKind;
  level?: number;
  /** Two gates on one page: still one event. */
  twice?: boolean;
};

async function render({ session, seed, sessionCookie, level = R, twice }: Mount) {
  const gate = (key: string) =>
    React.createElement(
      Gated,
      {
        key,
        contentNsfwLevel: level,
        meta: { title: 'x' },
      } as never,
      React.createElement('div', { 'data-testid': 'content' })
    );
  const tree = React.createElement(
    MantineProvider,
    null,
    React.createElement(
      SessionProvider,
      { session, seed, sessionCookie, refetchOnWindowFocus: false } as never,
      React.createElement(UpdateProbe),
      gate('a'),
      twice ? gate('b') : null
    )
  );
  if (!root) {
    container = document.createElement('div');
    root = createRoot(container);
  }
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

const events = () => h.pushEvent.mock.calls;
const LOGIN_CARD = 'This content requires an account';
const showsLoginCard = () => (container.textContent ?? '').includes(LOGIN_CARD);
const showsContent = () => !!container.querySelector('[data-testid="content"]');
const attributesOf = (i = 0) => {
  const { ms_since_nav_start, ...rest } = events()[i][1];
  expect(ms_since_nav_start).toMatch(/^\d+$/);
  return rest;
};

describe('Gated: login gate shown to a viewer whose hard load carried a session cookie', () => {
  it('a full render that resolved signed out with a cookie on the request — one event', async () => {
    // As `_app` passes it: `hasAuthCookie` cleared by the lookup ⇒ `session: null`.
    await render({ session: null, sessionCookie: 'civ-token', twice: true });
    await render({ session: null, sessionCookie: 'civ-token', twice: true });

    expect(showsLoginCard()).toBe(true);
    expect(events()).toHaveLength(1);
    expect(events()[0][0]).toBe('login_gate_with_auth_cookie');
    expect(attributesOf()).toEqual({
      render_mode: 'ssr',
      session_boot: 'ssr-null',
      session_cookie: 'true',
      session_cookie_kind: 'civ-token',
      session_history: 'unauthenticated',
      session_source: 'ssr',
      shell_seed_session: 'none',
      shell_page_data: 'none',
      last_fetch: 'none',
      last_fetch_status: 'none',
      last_fetch_trigger: 'none',
      fetch_count: '0',
      reload_triggered: 'false',
      reload_suppressed: 'false',
      content_nsfw_level: '4',
      sampleRate: '1',
    });
  });

  it('a shell whose page data said signed out', async () => {
    await render({ session: undefined, seed: null });
    expect(events()).toHaveLength(0);

    await render({ session: undefined, seed: { session: null } });
    expect(events()).toHaveLength(1);
    expect(attributesOf()).toMatchObject({
      render_mode: 'shell',
      session_boot: 'shell',
      session_cookie: 'unknown',
      session_cookie_kind: 'unknown',
      session_history: 'loading>unauthenticated',
      session_source: 'shell-seed',
      shell_seed_session: 'null',
      last_fetch: 'none',
    });
  });

  it('an unknown session whose mount fetch answered signed out', async () => {
    await render({ session: undefined });
    expect(events()).toHaveLength(0);

    await answer(0, new Response('{}', { status: 200 }));
    expect(events()).toHaveLength(1);
    expect(attributesOf()).toMatchObject({
      session_boot: 'ssr-unknown',
      session_history: 'loading>unauthenticated',
      session_source: 'fetch:mount',
      last_fetch: 'ok-null',
      last_fetch_status: '200',
      last_fetch_trigger: 'mount',
      fetch_count: '1',
    });
  });

  it('an unknown session whose mount fetch could not decide', async () => {
    await render({ session: undefined });
    await answer(0, new Response('', { status: 502 }));
    expect(events()).toHaveLength(1);
    expect(attributesOf()).toMatchObject({
      session_source: 'fetch:mount:undetermined',
      last_fetch: 'undetermined',
      last_fetch_status: '502',
    });
  });

  it('a signed-in shell that a refresh signal then signed out — and no user data in it', async () => {
    await render({ session: undefined, seed: null });
    await render({ session: undefined, seed: { session: SIGNED_IN } });
    expect(showsContent()).toBe(true);
    expect(events()).toHaveLength(0);

    let done: Promise<unknown> | undefined;
    await act(async () => {
      done = update?.('refresh-signal');
    });
    await answer(0, new Response('{}', { status: 200 }));
    await act(async () => {
      await done;
    });

    expect(showsLoginCard()).toBe(true);
    expect(events()).toHaveLength(1);
    expect(attributesOf()).toMatchObject({
      session_boot: 'shell',
      session_history: 'loading>authenticated>unauthenticated',
      session_source: 'fetch:refresh-signal',
      shell_seed_session: 'present',
      last_fetch: 'ok-null',
      last_fetch_trigger: 'refresh-signal',
      fetch_count: '1',
      reload_triggered: 'true',
      reload_suppressed: 'false',
    });
    const serialized = JSON.stringify(events()[0]);
    for (const leak of ['4141', 'gate-fixture-user', 'gate-fixture@example.test', 'expires'])
      expect(serialized).not.toContain(leak);
  });

  it('an untyped `update(arg)` caller is labelled `update`', async () => {
    await render({ session: undefined, seed: null });
    await render({ session: undefined, seed: { session: SIGNED_IN } });
    let done: Promise<unknown> | undefined;
    await act(async () => {
      // As `refresh: update` handed on as an event handler would call it.
      done = (update as unknown as (e: unknown) => Promise<unknown>)?.({ type: 'click' });
    });
    await answer(0, new Response('{}', { status: 200 }));
    await act(async () => {
      await done;
    });
    expect(events()).toHaveLength(1);
    expect(attributesOf()).toMatchObject({
      session_source: 'fetch:update',
      last_fetch_trigger: 'update',
    });
  });
});

describe('Gated: no event', () => {
  it('for a genuinely anonymous viewer (no session cookie)', async () => {
    await render({ session: null, sessionCookie: 'none' });
    // Positive control: the login card IS showing; only the cookie signal differs.
    expect(showsLoginCard()).toBe(true);
    expect(events()).toHaveLength(0);
  });

  it('for the `page` state: a signed-in viewer', async () => {
    await render({ session: SIGNED_IN, sessionCookie: 'civ-token' });
    expect(showsContent()).toBe(true);
    expect(events()).toHaveLength(0);
  });

  it('for the `page` state: PG content shown to a signed-out viewer with a cookie', async () => {
    await render({ session: null, sessionCookie: 'civ-token', level: PG });
    expect(showsContent()).toBe(true);
    expect(events()).toHaveLength(0);
  });

  it('for the `loading` state: a shell still waiting for its page data', async () => {
    await render({ session: undefined, seed: null });
    expect(showsContent()).toBe(false);
    expect(showsLoginCard()).toBe(false);
    expect(events()).toHaveLength(0);
  });
});
