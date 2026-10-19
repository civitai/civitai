// @vitest-environment happy-dom
/**
 * The client half of the `chat.getUserSettings` SSR seed: given the `chatSettings` page prop,
 * `AppProvider` primes the query so the chat widget's own `useQuery` never fetches. The server
 * half — that `_app.getInitialProps` returns the prop at all — is `app-ssr-seeds.test.ts`.
 *
 * Requests are counted at a fake transport behind a REAL React Query client with the app's own
 * default options, so a zero means React Query chose not to fetch.
 */
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';
import type { QueryClientTrpcFake } from '../../../test/queryClientTrpcFake';

const act = (React as unknown as { act: typeof actType }).act;

const CHAT_SETTINGS = 'chat.getUserSettings';

const h = vi.hoisted(() => ({ fake: undefined as unknown as QueryClientTrpcFake }));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof TrpcModule>();
  const { makeQueryClientTrpcFake } = await import('../../../test/queryClientTrpcFake');
  h.fake = makeQueryClientTrpcFake(actual.queryClient.getDefaultOptions());
  return { ...actual, trpc: h.fake.trpc };
});

import { AppProvider } from '~/providers/AppProvider';
import { trpc } from '~/utils/trpc';

const callsTo = (path: string) => h.fake.callsTo(path);

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

function render(props: Partial<ProviderProps>, { widget = true } = {}) {
  act(() => {
    root.render(
      React.createElement(
        AppProvider,
        { ...baseProps, ...props } as ProviderProps,
        widget ? React.createElement(ChatWidget) : null
      )
    );
  });
}

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

beforeEach(() => {
  h.fake.reset({ [CHAT_SETTINGS]: () => FROM_SERVER });
  seen = undefined;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('AppProvider — chat.getUserSettings seed', () => {
  it('a fully seeded page load issues no request at all, and the widget reads the seed', async () => {
    render({ chatSettings: STORED });
    await flush();

    // Every query `AppProvider` mounts is seeded here, chat settings included.
    expect(h.fake.calls()).toEqual([]);
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

  it('without a seed, AppProvider itself does not fetch (no 401 for anonymous viewers)', async () => {
    render({ chatSettings: undefined, isAuthed: false }, { widget: false });
    await flush();

    expect(callsTo(CHAT_SETTINGS)).toBe(0);
  });

  it('without a seed (anonymous or degraded render) the widget fetches for itself', async () => {
    // Positive control for every zero above: the same transport does see this request.
    render({ chatSettings: undefined });

    // Awaited, not flushed once: the result reaches the widget on React Query's own notify
    // schedule, which a single `setTimeout(0)` races.
    await vi.waitFor(() => expect(seen).toEqual(FROM_SERVER));
    expect(callsTo(CHAT_SETTINGS)).toBe(1);
  });
});
