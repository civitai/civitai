// @vitest-environment happy-dom
/**
 * A tab whose signed-in session ends elsewhere (signed out in another tab or on another site) reloads once
 * to re-sync with the server, instead of sitting on stale signed-in UI until the user reloads by hand.
 */
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '~/providers/SessionProvider';
import type { Session } from '~/types/session';

const act = (React as unknown as { act: typeof actType }).act;

const SIGNED_IN = { user: { id: 1, username: 'a' }, expires: '2099-01-01' } as unknown as Session;

let sessionResponse: () => Response;
let fetchCalls = 0;
let reload: ReturnType<typeof vi.fn>;
let root: Root | undefined;

beforeEach(() => {
  fetchCalls = 0;
  sessionResponse = () => new Response('{}', { status: 200 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      fetchCalls++;
      return sessionResponse();
    })
  );
  reload = vi.fn();
  vi.spyOn(window, 'location', 'get').mockReturnValue({
    ...window.location,
    reload,
  } as unknown as Location);
  window.sessionStorage.clear();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(props: { session?: Session | null }) {
  const container = document.createElement('div');
  root = createRoot(container);
  await act(async () => {
    root!.render(React.createElement(SessionProvider, props, null));
  });
}

async function focus() {
  const before = fetchCalls;
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
  await vi.waitFor(() => expect(fetchCalls).toBe(before + 1));
  await act(() => Promise.resolve());
}

describe('SessionProvider: reload when the session ends elsewhere', () => {
  it('reloads once when an established session disappears', async () => {
    await mount({ session: SIGNED_IN });
    await focus();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload a second time when the session is still gone', async () => {
    await mount({ session: SIGNED_IN });
    await focus();
    await focus();
    await focus();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads only once when session storage is unavailable', async () => {
    vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new Error('blocked');
    });
    await mount({ session: SIGNED_IN });
    await focus();
    await focus();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload a tab that was signed out from the start', async () => {
    await mount({ session: null });
    await focus();
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not reload on first load when the fetched session is signed out', async () => {
    await mount({});
    await vi.waitFor(() => expect(fetchCalls).toBe(1));
    await focus();
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not reload on a failed session check', async () => {
    await mount({ session: SIGNED_IN });
    sessionResponse = () => new Response('', { status: 502 });
    await focus();
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not reload again right after a reload that brought the session back', async () => {
    await mount({ session: SIGNED_IN });
    await focus();
    expect(reload).toHaveBeenCalledTimes(1);
    await act(async () => root?.unmount());

    // The reloaded page: rendered signed in, then the session is lost again.
    await mount({ session: SIGNED_IN });
    await focus();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
