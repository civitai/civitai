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
const openModal = vi.hoisted(() => vi.fn());
vi.mock('~/components/Dialog/triggers/remix-app', () => ({ openRemixAppModal: openModal }));

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
      requests.push({ path, body: String(init?.body ?? '') });
      const data = path === 'remixApp.teamQuote' ? quote : null;
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
  openModal.mockClear();
  stubFetch();
  flags.remixApps = true;
  quote = null;
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

  const eligible = { team: 'Pink', price: { cost: 44, ready: true } };
  const tap = async () => {
    await act(async () => {
      button()?.click();
    });
    await settle();
  };

  it("opens the team app's modal for this image, and runs nothing itself", async () => {
    quote = eligible;
    await render();
    await tap();

    expect(openModal).toHaveBeenCalledTimes(1);
    expect(openModal.mock.calls[0][0]).toMatchObject({
      app: { slug: TEAM_REMIX_SLUG, name: 'Remix for Team Pink', runtime: false },
      imageId: HOST,
    });
    expect(count('remixApp.run')).toBe(0);
  });

  it('shows the refusal instead of a price, and cannot be tapped', async () => {
    quote = {
      team: 'Pink',
      price: { refusal: 'Remix for your team does not run on mature images.' },
    };
    await render();
    expect(button()?.disabled).toBe(true);
    expect(container.textContent).toContain('does not run on mature images');
    button()?.click();
    expect(openModal).not.toHaveBeenCalled();
  });
});
