// @vitest-environment happy-dom
/**
 * A shell page mounts SessionProvider with a seed on its way (`seed: null`) and adopts the
 * session from the page data once it arrives. Nothing may resolve the session to signed-out
 * before then on an answer that was not authoritative — nor while another fetch that can still
 * decide it is running.
 */
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider, useSession } from '~/providers/SessionProvider';
import type { SessionSeed } from '~/providers/SessionProvider';
import type { Session } from '~/types/session';

const act = (React as unknown as { act: typeof actType }).act;

const SIGNED_IN = {
  user: { id: 41, username: 'seeded' },
  expires: '2099-01-01',
} as unknown as Session;

/** Each `/api/auth/session` request, answered when the test chooses. */
let pending: ((res: Response) => void)[] = [];
let root: Root | undefined;
/** `useSession().status` at every commit, in order. */
let statuses: string[] = [];

function Probe() {
  const { status } = useSession();
  React.useEffect(() => {
    statuses.push(status);
  });
  return null;
}

beforeEach(() => {
  pending = [];
  statuses = [];
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

const last = () => statuses[statuses.length - 1];

async function render(seed: SessionSeed | null) {
  // As `_app` passes it on a shell page: no session prop (unknown), the seed on its way.
  const tree = React.createElement(
    SessionProvider,
    { session: undefined, seed } as never,
    React.createElement(Probe)
  );
  if (!root) root = createRoot(document.createElement('div'));
  await act(async () => {
    root!.render(tree);
  });
}

async function focus() {
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
}

/** Answers the `index`th session request. */
async function answer(index: number, res: Response) {
  await vi.waitFor(() => expect(pending.length).toBeGreaterThan(index));
  await act(async () => {
    pending[index](res);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const failed = () => new Response('', { status: 502 });
const signedIn = () => new Response(JSON.stringify(SIGNED_IN), { status: 200 });

describe('SessionProvider: an undetermined refetch does not pre-empt a seed or fetch still on its way', () => {
  it('a focus refetch that fails while the seed is on its way leaves the session loading', async () => {
    await render(null);
    expect(last()).toBe('loading');

    await focus();
    await answer(0, failed());
    expect(last()).toBe('loading');

    await render({ session: SIGNED_IN });
    expect(last()).toBe('authenticated');
    expect(statuses).not.toContain('unauthenticated');
  });

  it('a failed refetch that lands while the first fetch is still running does not decide', async () => {
    const tree = React.createElement(
      SessionProvider,
      { session: undefined } as never,
      React.createElement(Probe)
    );
    root = createRoot(document.createElement('div'));
    await act(async () => {
      root!.render(tree);
    });
    expect(pending).toHaveLength(1);

    await focus();
    expect(pending).toHaveLength(2);
    await answer(1, failed());
    expect(last()).toBe('loading');

    await answer(0, signedIn());
    expect(last()).toBe('authenticated');
    expect(statuses).not.toContain('unauthenticated');
  });

  it('control: with no seed coming, a failed first fetch still resolves to signed-out', async () => {
    const tree = React.createElement(
      SessionProvider,
      { session: undefined } as never,
      React.createElement(Probe)
    );
    root = createRoot(document.createElement('div'));
    await act(async () => {
      root!.render(tree);
    });
    expect(pending).toHaveLength(1);

    await answer(0, failed());
    expect(last()).toBe('unauthenticated');
  });
});
