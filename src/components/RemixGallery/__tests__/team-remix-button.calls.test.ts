// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import { act, createElement } from 'react';
import type { ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeamRemixButton } from '~/components/RemixGallery/TeamRemixButton';
import type * as FeatureFlagsProvider from '~/providers/FeatureFlagsProvider';
import { TEAM_REMIX_SLUG } from '~/shared/constants/remix-apps.constants';
import { queryClient, trpc } from '~/utils/trpc';

/** Counted on the wire: the real tRPC client runs, only `fetch` is stubbed. */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flags = vi.hoisted(() => ({ remixApps: true }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 7 }) }));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsProvider>()),
  useFeatureFlags: () => flags,
}));
vi.mock('@mantine/notifications', () => ({ showNotification: vi.fn() }));

const HOST = 74;
let quote: unknown = null;
const requests: { path: string; body: string }[] = [];

function stubFetch() {
  requests.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://test');
      const path = url.pathname.replace('/api/trpc/', '');
      requests.push({ path, body: `${url.search} ${String(init?.body ?? '')}` });
      const data =
        path === 'remixApp.teamQuote'
          ? quote
          : path === 'remixApp.run'
          ? { workflowId: 'wf', tier: 'safe', cost: 44 }
          : null;
      return new Response(JSON.stringify({ result: { data: { json: data } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    })
  );
}

let root: Root | undefined;
let container: HTMLElement;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
}

async function render() {
  queryClient.clear();
  const Inner = () =>
    createElement(MantineProvider, null, createElement(TeamRemixButton, { imageId: HOST }));
  const Wrapped = trpc.withTRPC(Inner as never) as unknown as ComponentType<{ pageProps: object }>;
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(Wrapped, { pageProps: {} }));
  });
  await settle();
}

const count = (path: string) => requests.filter((r) => r.path === path).length;
const button = () =>
  [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Remix for your team')
  );

beforeEach(() => {
  stubFetch();
  flags.remixApps = true;
  quote = null;
  localStorage.clear();
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('the Remix for your team button', () => {
  it('asks nothing and shows nothing with the remixApps flag off', async () => {
    flags.remixApps = false;
    quote = { team: 'Pink', price: { cost: 44, ready: true } };
    await render();
    expect(count('remixApp.teamQuote')).toBe(0);
    expect(button()).toBeUndefined();
  });

  it('shows only where the server names a team', async () => {
    await render();
    // POSITIVE CONTROL: the instrument saw the button's own query.
    expect(count('remixApp.teamQuote')).toBe(1);
    expect(button()).toBeUndefined();

    act(() => root?.unmount());
    quote = { team: 'Pink', price: { cost: 44, ready: true } };
    await render();
    expect(button()).toBeDefined();
  });

  it('runs the team app and never sends a team', async () => {
    localStorage.setItem('remix-apps:confirmed', '1');
    quote = { team: 'Pink', price: { cost: 44, ready: true } };
    await render();
    await act(async () => {
      button()?.click();
    });
    await settle();

    const runs = requests.filter((r) => r.path === 'remixApp.run');
    expect(runs).toHaveLength(1);
    expect(runs[0].body).toContain(TEAM_REMIX_SLUG);
    expect(runs[0].body).toContain(String(HOST));
    expect(runs[0].body).not.toMatch(/Pink|team"/);
  });
});
