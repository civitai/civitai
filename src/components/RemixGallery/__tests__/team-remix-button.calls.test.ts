// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { act, createElement } from 'react';
import type { ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIRMED_KEY } from '~/components/Image/Remix/RemixApps';
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
let runFails = false;
/** While set, a run answers only once it is resolved: a submit still in flight. */
let holdRun: Promise<void> | null = null;

function stubFetch() {
  requests.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://test');
      const path = url.pathname.replace('/api/trpc/', '');
      requests.push({ path, body: String(init?.body ?? '') });
      if (path === 'remixApp.run' && holdRun) await holdRun;
      if (path === 'remixApp.run' && runFails)
        return new Response(
          JSON.stringify({ error: { json: { message: 'nope', code: -32603, data: {} } } }),
          { status: 500, headers: { 'content-type': 'application/json' } }
        );
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
    createElement(
      MantineProvider,
      null,
      createElement(ModalsProvider, null, createElement(TeamRemixButton, { imageId: HOST }))
    );
  const Wrapped = trpc.withTRPC(Inner as never) as unknown as ComponentType<{ pageProps: object }>;
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(Wrapped, { pageProps: {} }));
  });
  await settle();
}

/** The run inputs as sent, read out of the (possibly batched) tRPC body. */
const runInputs = () =>
  requests
    .filter((r) => r.path === 'remixApp.run')
    .map((r) => {
      const body = JSON.parse(r.body) as Record<string, { json?: unknown }> & { json?: unknown };
      return (body.json ?? body[0]?.json ?? body['0']?.json) as Record<string, unknown>;
    });

const count = (path: string) => requests.filter((r) => r.path === path).length;
const button = () =>
  [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Remix for your team')
  );

beforeEach(() => {
  stubFetch();
  flags.remixApps = true;
  quote = null;
  runFails = false;
  holdRun = null;
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

  const eligible = { team: 'Pink', price: { cost: 44, ready: true } };
  const tap = async () => {
    await act(async () => {
      button()?.click();
    });
    await settle();
  };
  const isLoading = () => button()?.hasAttribute('data-loading') ?? false;

  it('runs the team app on this image and never sends a team', async () => {
    localStorage.setItem(CONFIRMED_KEY, '1');
    quote = eligible;
    await render();
    await tap();

    const runs = runInputs();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ slug: TEAM_REMIX_SLUG, imageId: HOST });
    expect(Object.keys(runs[0]).sort()).toEqual(['imageId', 'nonce', 'slug']);
  });

  it('gives each tap its own nonce once the last one settled, failed or not', async () => {
    localStorage.setItem(CONFIRMED_KEY, '1');
    quote = eligible;
    await render();
    runFails = true;
    await tap();
    expect(isLoading()).toBe(false);
    runFails = false;
    await tap();

    const [first, second] = runInputs();
    expect(second).toBeDefined();
    expect(second.nonce).not.toBe(first.nonce);
  });

  it('holds the button and its nonce from Run until the submit settles', async () => {
    quote = eligible;
    await render();
    let release = () => undefined as void;
    holdRun = new Promise((resolve) => (release = resolve));
    await tap();
    const run = [...document.body.querySelectorAll('button')].find((b) => b.textContent === 'Run');
    expect(run).toBeDefined();
    await act(async () => {
      run?.click();
    });
    await settle();
    // The confirm has closed, the submit has not answered: still one tap.
    expect(runInputs()).toHaveLength(1);
    expect(isLoading()).toBe(true);

    await act(async () => {
      release();
    });
    await settle();
    expect(isLoading()).toBe(false);
  });

  it('frees the button when the confirm is cancelled, and runs nothing', async () => {
    quote = eligible;
    await render();
    await tap();
    // POSITIVE CONTROL: the confirm opened and the button is held while it is open.
    const cancel = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent === 'Cancel'
    );
    expect(cancel).toBeDefined();
    expect(isLoading()).toBe(true);

    await act(async () => {
      cancel?.click();
    });
    await settle();
    expect(isLoading()).toBe(false);
    expect(runInputs()).toHaveLength(0);
  });

  it('shows the refusal instead of a price, and cannot be tapped', async () => {
    quote = {
      team: 'Pink',
      price: { refusal: 'Remix for your team does not run on mature images.' },
    };
    await render();
    expect(button()?.disabled).toBe(true);
    expect(container.textContent).toContain('does not run on mature images');
  });
});
