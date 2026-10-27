// @vitest-environment happy-dom
/**
 * `SessionDiagnostics`: the record SessionProvider keeps of how the session got to its value, for
 * the login-gate diagnostic. It must record the transitions and what produced each value — and
 * change nothing the provider's consumers see.
 */
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider, useSession, useSessionDiagnostics } from '~/providers/SessionProvider';
import type { SessionDiagnostics, SessionSeed } from '~/providers/SessionProvider';
import type { Session } from '~/types/session';
import type { SessionCookieKind } from '~/shared/utils/session-cookie';

const act = (React as unknown as { act: typeof actType }).act;

const SIGNED_IN = {
  user: { id: 41, username: 'seeded' },
  expires: '2099-01-01',
} as unknown as Session;

let pending: ((res: Response) => void)[] = [];
let root: Root | undefined;
let statuses: string[] = [];
let diagnostics: SessionDiagnostics | undefined;

function Probe() {
  const { status } = useSession();
  const diag = useSessionDiagnostics();
  React.useEffect(() => {
    statuses.push(status);
    diagnostics = diag;
  });
  return null;
}

beforeEach(() => {
  pending = [];
  statuses = [];
  diagnostics = undefined;
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

async function render(props: {
  session?: Session | null;
  seed?: SessionSeed | null;
  sessionCookie?: SessionCookieKind;
}) {
  const tree = React.createElement(SessionProvider, props as never, React.createElement(Probe));
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

async function focus() {
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
}

describe('SessionDiagnostics', () => {
  it('a server-rendered session: boot, cookie signal, one status, no fetch', async () => {
    await render({ session: SIGNED_IN, sessionCookie: 'civ-token' });
    expect(diagnostics).toEqual({
      boot: 'ssr-session',
      sessionCookie: true,
      sessionCookieKind: 'civ-token',
      authCookieAtLoad: true,
      reloadTriggered: false,
      reloadSuppressed: false,
      history: ['authenticated'],
      source: 'ssr',
      fetchCount: 0,
    });
  });

  it('server-rendered signed out with no cookie is the only boot without the cookie signal', async () => {
    await render({ session: null, sessionCookie: 'none' });
    expect(diagnostics).toMatchObject({
      boot: 'ssr-null',
      sessionCookie: false,
      sessionCookieKind: 'none',
      authCookieAtLoad: false,
    });
  });

  it('server-rendered signed out WITH a cookie keeps the cookie signal', async () => {
    await render({ session: null, sessionCookie: 'legacy' });
    expect(diagnostics).toMatchObject({
      boot: 'ssr-null',
      sessionCookie: true,
      sessionCookieKind: 'legacy',
      authCookieAtLoad: true,
    });
  });

  it('records each distinct transition and what produced it: mount fetch, then a focus fetch', async () => {
    await render({ session: undefined });
    expect(diagnostics).toMatchObject({ boot: 'ssr-unknown', authCookieAtLoad: true });

    await answer(0, new Response(JSON.stringify(SIGNED_IN), { status: 200 }));
    expect(diagnostics).toMatchObject({
      history: ['loading', 'authenticated'],
      source: 'fetch:mount',
      fetchCount: 1,
      lastFetch: { trigger: 'mount', outcome: 'ok-session', httpStatus: 200 },
    });

    // Undetermined after a session: the value (and its source) stand; the fetch is recorded.
    await focus();
    await answer(1, new Response('', { status: 503 }));
    expect(diagnostics).toMatchObject({
      history: ['loading', 'authenticated'],
      source: 'fetch:mount',
      fetchCount: 2,
      lastFetch: { trigger: 'focus', outcome: 'undetermined', httpStatus: 503 },
    });

    await focus();
    await answer(2, new Response('{}', { status: 200 }));
    expect(diagnostics).toMatchObject({
      history: ['loading', 'authenticated', 'unauthenticated'],
      source: 'fetch:focus',
      fetchCount: 3,
      lastFetch: { trigger: 'focus', outcome: 'ok-null', httpStatus: 200 },
      reloadTriggered: true,
      reloadSuppressed: false,
    });
    // Unchanged contract: the statuses consumers saw are the same three.
    expect([...new Set(statuses)]).toEqual(['loading', 'authenticated', 'unauthenticated']);
  });

  it('a lost session inside the reload cooldown is recorded as suppressed', async () => {
    window.sessionStorage.setItem('civitai:lost-session-reload', String(Date.now()));
    await render({ session: SIGNED_IN, sessionCookie: 'civ-token' });
    await focus();
    await answer(0, new Response('{}', { status: 200 }));
    expect(window.location.reload).not.toHaveBeenCalled();
    expect(diagnostics).toMatchObject({ reloadTriggered: false, reloadSuppressed: true });
  });

  it('a network error is `undetermined` with status 0 and marks the resolution', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network');
      })
    );
    await render({ session: undefined });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(diagnostics?.fetchCount).toBe(1);
    expect(diagnostics).toMatchObject({
      history: ['loading', 'unauthenticated'],
      source: 'fetch:mount:undetermined',
      lastFetch: { trigger: 'mount', outcome: 'undetermined', httpStatus: 0 },
    });
  });

  it('a shell: the seed is recorded as the source', async () => {
    await render({ session: undefined, seed: null });
    expect(diagnostics).toMatchObject({ boot: 'shell', history: ['loading'], source: 'ssr' });
    await render({ session: undefined, seed: { session: SIGNED_IN } });
    expect(diagnostics).toMatchObject({
      history: ['loading', 'authenticated'],
      source: 'shell-seed',
      seedSession: 'present',
      fetchCount: 0,
    });
  });
});
