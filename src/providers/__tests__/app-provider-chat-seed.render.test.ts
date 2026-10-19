// @vitest-environment happy-dom
/**
 * The client half of the `chat.getUserSettings` SSR seed: given the `chatSettings` page prop,
 * `AppProvider` primes the query so the chat widget's own `useQuery` never fetches. The server
 * half — that `_app.getInitialProps` returns the prop at all — is `app-ssr-seeds.test.ts`.
 *
 * Requests are counted at a fake transport behind a REAL React Query client with the app's own
 * default options, so a zero means React Query chose not to fetch.
 */
import { QueryClient, useQuery } from '@tanstack/react-query';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';

const act = (React as unknown as { act: typeof actType }).act;

const CHAT_SETTINGS = 'chat.getUserSettings';

const h = vi.hoisted(() => ({
  calls: [] as string[],
  responses: {} as Record<string, () => unknown>,
  client: undefined as unknown,
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof TrpcModule>();
  const client = new QueryClient({ defaultOptions: actual.queryClient.getDefaultOptions() });
  h.client = client;
  const key = (path: string, input: unknown) => [path, input ?? null];
  const proc = (path: string) => ({
    useQuery: (input: unknown, opts: Record<string, unknown> = {}) => {
      const { trpc: _trpc, ...rest } = opts;
      return useQuery(
        {
          queryKey: key(path, input),
          queryFn: async () => {
            h.calls.push(path);
            return h.responses[path]?.() ?? null;
          },
          ...rest,
        },
        client
      );
    },
  });
  const routers = new Proxy(
    {},
    {
      get: (_r, router) =>
        new Proxy({}, { get: (_p, name) => proc(`${String(router)}.${String(name)}`) }),
    }
  );
  return { ...actual, trpc: routers };
});

import { AppProvider } from '~/providers/AppProvider';
import { trpc } from '~/utils/trpc';

const queryClient = () => h.client as QueryClient;
const callsTo = (path: string) => h.calls.filter((p) => p === path).length;

const STORED = { muteSounds: true, replaceBadWords: true, acknowledged: true };
const FROM_SERVER = { muteSounds: false, replaceBadWords: false, acknowledged: true };

let seen: unknown;
/** What the chat widget does: `ExistingChat`/`useChatTheme` read the same fixed key. */
function ChatWidget() {
  const { data } = trpc.chat.getUserSettings.useQuery(undefined);
  seen = data;
  return null;
}

type ProviderProps = React.ComponentProps<typeof AppProvider>;
const baseProps: Omit<ProviderProps, 'children'> = {
  settings: {} as ProviderProps['settings'],
  liveNow: false,
  following: [1],
  navBanners: [],
  seed: 1,
  canIndex: true,
  domain: 'blue',
  host: 'civitai.com',
  serverDomains: {} as ProviderProps['serverDomains'],
  availableOAuthProviders: [],
  verifiedBot: null,
  isAuthed: true,
};

let container: HTMLDivElement;
let root: Root;

function render(props: Partial<ProviderProps>) {
  act(() => {
    root.render(
      React.createElement(
        AppProvider,
        { ...baseProps, ...props } as ProviderProps,
        React.createElement(ChatWidget)
      )
    );
  });
}

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

beforeEach(() => {
  h.calls = [];
  h.responses = { [CHAT_SETTINGS]: () => FROM_SERVER };
  seen = undefined;
  queryClient().clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('AppProvider — chat.getUserSettings seed', () => {
  it('a seeded page load does not request chat settings, and the widget reads the seed', async () => {
    render({ chatSettings: STORED });
    await flush();

    expect(callsTo(CHAT_SETTINGS)).toBe(0);
    expect(seen).toEqual(STORED);
  });

  it('a client navigation (no chatSettings prop) does not request them either', async () => {
    render({ chatSettings: STORED });
    await flush();
    // On a client-side navigation `getInitialProps` returns no seeds, so the prop goes undefined.
    render({ chatSettings: undefined });
    await flush();

    expect(callsTo(CHAT_SETTINGS)).toBe(0);
    expect(seen).toEqual(STORED);
  });

  it("the user's own settings change still reaches the widget", async () => {
    render({ chatSettings: STORED });
    await flush();

    // What `ChatSettings`' optimistic update writes.
    act(() => {
      queryClient().setQueryData([CHAT_SETTINGS, null], { ...STORED, muteSounds: false });
    });
    await flush();

    expect(seen).toEqual({ ...STORED, muteSounds: false });
    expect(callsTo(CHAT_SETTINGS)).toBe(0);
  });

  it('without a seed (anonymous or degraded render) the widget fetches for itself', async () => {
    // Positive control for every zero above: the same transport does see this request.
    render({ chatSettings: undefined });
    await flush();

    expect(callsTo(CHAT_SETTINGS)).toBe(1);
    expect(seen).toEqual(FROM_SERVER);
  });
});
