// @vitest-environment happy-dom
/**
 * The client half of the event seeds: given the `eventSeeds` page prop, `AppProvider` primes
 * `event.getAccess` and `event.getCosmetic` so the app-wide point pops (`EventPointsSelfPops`,
 * through `usePlayableEventDecoration`) never ask for them on a page load. The server half is
 * `event-seeds.service.test.ts`, and that `_app` hands the prop on is `app-ssr-seeds.test.ts`.
 *
 * Runs the REAL tRPC client with only `fetch` stubbed, so a seed lands (or not) under tRPC's own
 * query keys, and the consumer is the real component with the app's own query options.
 */
import type { ComponentProps, ComponentType, ReactNode } from 'react';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BrowserSettingsModule from '~/providers/BrowserSettingsProvider';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const viewer = vi.hoisted(() => ({ user: { id: 7 } as { id: number } | null }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => viewer.user }));
vi.mock('~/providers/BrowserSettingsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserSettingsModule>()),
  useShowEventCosmetics: () => true,
  useBrowsingSettings: (select: (s: { eventPointPops: string }) => unknown) =>
    select({ eventPointPops: 'all' }),
}));
// Its real module opens the signals worker; nothing here reaches it (the viewer has not joined).
vi.mock('~/components/Signals/SignalsProvider', () => ({ useSignalConnection: () => undefined }));

const { trpc, queryClient } = await import('~/utils/trpc');
const { AppProvider } = await import('~/providers/AppProvider');
const { EventPointsSelfPops } = await import('~/components/HatTurf/EventPointsSelfPops');
const { getReleasedEventDecoration } = await import(
  '~/shared/constants/event-decoration.constants'
);
const { CosmeticEntity } = await import('~/shared/utils/prisma/enums');

const EVENT = 'birthday2026';
// While the event is running, so its hat is released for images.
const NOW = new Date('2026-11-15T12:00:00.000Z');
const ACCESS = 'open';
const COSMETIC = { available: true, obtained: false, equipped: false, data: {}, cosmetic: null };

/** Every tRPC procedure the run asked for, one entry per procedure (a batch counts each). */
const asked: string[] = [];
function stubFetch() {
  asked.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
      const paths = url.pathname.startsWith('/api/trpc/')
        ? url.pathname.slice('/api/trpc/'.length).split(',')
        : [url.pathname];
      asked.push(...paths);
      const answers: Record<string, unknown> = {
        'event.getAccess': ACCESS,
        'event.getCosmetic': COSMETIC,
      };
      // The client transformer reads superjson's `{ json }` envelope.
      const body = paths.map((path) => ({ result: { data: { json: answers[path] ?? null } } }));
      return new Response(JSON.stringify(url.searchParams.has('batch') ? body : body[0]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    })
  );
}
const askedFor = (path: string) => asked.filter((p) => p === path).length;

type ProviderProps = ComponentProps<typeof AppProvider>;
const baseProps: Omit<ProviderProps, 'children'> = {
  settings: {} as ProviderProps['settings'],
  liveNow: false,
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

function App({ providerProps }: { providerProps: Partial<ProviderProps> }) {
  return h(
    AppProvider,
    { ...baseProps, ...providerProps } as ProviderProps,
    h(EventPointsSelfPops) as ReactNode
  );
}
const Wrapped = trpc.withTRPC(App as never) as unknown as ComponentType<{
  providerProps: Partial<ProviderProps>;
}>;

let root: Root | undefined;
async function render(providerProps: Partial<ProviderProps>) {
  root = createRoot(document.createElement('div'));
  await act(async () => {
    root?.render(h(Wrapped, { providerProps }));
  });
  for (let i = 0; i < 3; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  viewer.user = { id: 7 };
  // The browser client is a module singleton: each page load starts from an empty cache.
  queryClient.clear();
  stubFetch();
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('AppProvider — event.getAccess / event.getCosmetic seeds', () => {
  it('fixture: the event decoration is released at the test clock', () => {
    // Without this, every zero below could be a component that asks nothing at all.
    expect(getReleasedEventDecoration(CosmeticEntity.Image)?.event).toBe(EVENT);
  });

  it('without seeds, a page load asks for both (positive control)', async () => {
    await render({});
    expect(askedFor('event.getAccess')).toBe(1);
    expect(askedFor('event.getCosmetic')).toBe(1);
  });

  it('with seeds, a page load asks for neither', async () => {
    await render({ eventSeeds: [{ event: EVENT, access: ACCESS, cosmetic: COSMETIC }] });
    expect(asked).toEqual([]);
  });

  it('a seed without a cosmetic still saves the access read, and the cosmetic is fetched', async () => {
    await render({ eventSeeds: [{ event: EVENT, access: ACCESS }] });
    expect(askedFor('event.getAccess')).toBe(0);
    expect(askedFor('event.getCosmetic')).toBe(1);
  });

  it('a closed seed is honoured: no cosmetic is asked for, as with a fetched closed answer', async () => {
    await render({ eventSeeds: [{ event: EVENT, access: 'closed' }] });
    expect(asked).toEqual([]);
  });
});
