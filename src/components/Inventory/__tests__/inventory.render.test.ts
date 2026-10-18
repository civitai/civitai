// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { state } = vi.hoisted(() => ({
  state: {
    held: [] as unknown[],
    openings: [] as unknown[],
    flags: { mysteryBox: true } as Record<string, boolean> | null,
    unopenedBoxes: 0,
    trigger: vi.fn(),
    setCounts: vi.fn(),
    openingsOptions: undefined as undefined | { getNextPageParam: (page: unknown) => unknown },
    hasNextPage: false,
    fetchNextPage: vi.fn(),
  },
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy(
    {
      'mysteryBox.getHeld': { useQuery: () => ({ data: state.held, isLoading: false }) },
      'mysteryBox.getOpenings': {
        useInfiniteQuery: (
          _input: unknown,
          options: { getNextPageParam: (page: unknown) => unknown }
        ) => {
          state.openingsOptions = options;
          return {
            data: { pages: [{ items: state.openings, nextCursor: undefined }] },
            isLoading: false,
            hasNextPage: state.hasNextPage,
            fetchNextPage: state.fetchNextPage,
            isFetchingNextPage: false,
          };
        },
      },
    },
    { useUtils: () => ({ user: { checkNotifications: { setData: state.setCounts } } }) }
  ),
}));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useOptionalFeatureFlags: () => state.flags,
}));
vi.mock('~/components/Notifications/notifications.utils', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useQueryNotificationsCount: () => ({ unopenedBoxes: state.unopenedBoxes }),
}));
vi.mock('~/components/Dialog/dialogStore', () => ({ dialogStore: { trigger: state.trigger } }));
vi.mock('~/components/MysteryBox/MysteryBoxModal', () => ({
  default: function MysteryBoxModal() {
    return null;
  },
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia: ({ src }: { src: string }) => React.createElement('img', { 'data-src': src }),
}));
vi.mock('~/components/Events/events.utils', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTeamColor: () => (team: string) => team === 'Pink' ? '#f06595' : undefined,
}));
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 42 }) }));

import { InventoryLayout } from '../InventoryLayout';
import type { HeldMysteryBox } from '~/components/MysteryBox/mystery-box.utils';

const content = (contentId: number, left = true) => ({
  contentId,
  tierId: 7,
  cosmeticId: 1000 + contentId,
  name: `Hat ${contentId}`,
  url: null,
  fit: null,
  left,
});
const held = (overrides: Partial<HeldMysteryBox> = {}): HeldMysteryBox => ({
  boxDefinitionId: 9,
  name: 'Pink Mystery Hat Box',
  description: null,
  version: 3,
  team: 'Pink',
  art: null,
  listing: null,
  tiers: [{ id: 7, key: 'common', name: 'Common', color: null, weight: 1, sortOrder: 0 }],
  contents: [content(1), content(2)],
  heldBoxItemIds: ['501', '502'],
  event: 'birthday2026',
  heldItems: [
    { id: '501', acquiredAt: new Date('2026-11-01T00:00:00Z') },
    { id: '502', acquiredAt: new Date('2026-11-02T00:00:00Z') },
  ],
  ...overrides,
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const render = async (typeKey = 'boxes') => {
  await act(async () =>
    root.render(
      React.createElement(MantineProvider, null, React.createElement(InventoryLayout, { typeKey }))
    )
  );
};
const all = (selector: string) => [...container.querySelectorAll(selector)];
const openButtons = () =>
  all('[data-testid="unopened-box"] button').filter(
    (b) => b.textContent === 'Open'
  ) as HTMLButtonElement[];
const triggered = () =>
  state.trigger.mock.calls.map(
    ([arg]) =>
      (arg as { props: Record<string, unknown> }).props as {
        source: unknown;
        boxDefinitionId: number;
        boxItemId?: string;
        start?: string;
        color: string;
      }
  );

beforeEach(() => {
  state.trigger.mockReset();
  state.setCounts.mockReset();
  state.fetchNextPage.mockReset();
  state.hasNextPage = false;
  state.openingsOptions = undefined;
  state.held = [];
  state.openings = [];
  state.flags = { mysteryBox: true };
  state.unopenedBoxes = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('Inventory', () => {
  it('lists Boxes, with the unopened count, while mystery boxes are on', async () => {
    state.unopenedBoxes = 3;
    await render();

    const links = all('nav[aria-label="Inventory"] a');
    expect(links[0].getAttribute('href')).toBe('/user/inventory/boxes');
    expect(links[0].textContent).toBe('Boxes3');
    expect(links[0].getAttribute('aria-current')).toBe('page');
  });

  it('lists nothing and shows no box page with mystery boxes off', async () => {
    state.flags = { mysteryBox: false };
    state.held = [held()];
    await render();

    expect(all('nav[aria-label="Inventory"] a')).toEqual([]);
    expect(all('[data-testid="unopened-box"]')).toEqual([]);
    expect(container.textContent).toContain('Nothing to show here.');
  });
});

describe('Inventory boxes', () => {
  it('shows every unopened box, and each Open opens that box from the Inventory', async () => {
    state.held = [
      held(),
      held({
        boxDefinitionId: 10,
        name: 'Plain Box',
        team: undefined,
        event: null,
        heldBoxItemIds: ['601'],
        heldItems: [{ id: '601', acquiredAt: new Date('2026-11-03T00:00:00Z') }],
      }),
    ];
    await render();

    expect(
      all('[data-testid="unopened-box"]').map((row) => row.querySelector('p')?.textContent)
    ).toEqual(['Pink Mystery Hat Box', 'Pink Mystery Hat Box', 'Plain Box']);
    for (const button of openButtons()) await act(async () => button.click());

    expect(
      triggered().map(({ source, boxDefinitionId, boxItemId, start, color }) => ({
        source,
        boxDefinitionId,
        boxItemId,
        start,
        color,
      }))
    ).toEqual([
      {
        source: { inventory: true },
        boxDefinitionId: 9,
        boxItemId: '501',
        start: 'open',
        color: '#f06595',
      },
      {
        source: { inventory: true },
        boxDefinitionId: 9,
        boxItemId: '502',
        start: 'open',
        color: '#f06595',
      },
      {
        source: { inventory: true },
        boxDefinitionId: 10,
        boxItemId: '601',
        start: 'open',
        color: 'var(--mantine-color-blue-5)',
      },
    ]);
  });

  it('counts the unopened boxes on their tab, and brings the menu badge up to date', async () => {
    state.held = [held()];
    await render();

    const tabs = all('[role="tab"]').map((t) => t.textContent);
    expect(tabs).toEqual(['Unopened (2)', 'Opened']);
    const [, update] = state.setCounts.mock.calls.at(-1)!;
    expect(update({ all: 4, unopenedBoxes: 5 })).toEqual({ all: 4, unopenedBoxes: 2 });
  });

  it('pages the opened list by the cursor the server returns', async () => {
    state.openings = [
      { boxItemId: '32', openedAt: new Date(2026, 10, 3, 12), box: null, tier: null, reward: null },
    ];
    state.hasNextPage = true;
    await render();
    const openedTab = all('[role="tab"]').find((t) => t.textContent === 'Opened') as HTMLElement;
    await act(async () => openedTab.click());

    expect(state.openingsOptions?.getNextPageParam({ items: [], nextCursor: '33' })).toBe('33');
    expect(
      state.openingsOptions?.getNextPageParam({ items: [], nextCursor: undefined })
    ).toBeUndefined();
    const more = all('button').find((b) => b.textContent === 'Load more') as HTMLButtonElement;
    await act(async () => more.click());
    expect(state.fetchNextPage).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('A reward');
  });

  it("can't open a box the viewer has collected everything in, and says why", async () => {
    state.held = [held({ contents: [content(1, false), content(2, false)] })];
    await render();

    expect(openButtons().map((b) => b.disabled)).toEqual([true, true]);
    expect(container.textContent).toContain('You have everything in it.');
  });

  it('says where boxes land when there are none', async () => {
    await render();

    expect(container.textContent).toContain("Boxes you earn or buy and don't open land here.");
  });

  it('shows what each earlier open gave, its rarity and its box', async () => {
    state.openings = [
      {
        boxItemId: '32',
        // Local noon: the table shows the viewer's own date.
        openedAt: new Date(2026, 10, 3, 12),
        box: { id: 9, name: 'Pink Mystery Hat Box' },
        tier: { id: 6, name: 'Rare', color: '#3b82f6', sortOrder: 2 },
        reward: { name: 'Frog', url: 'frog.png', cosmeticType: 'ContentDecoration' },
      },
    ];
    await render();
    const openedTab = all('[role="tab"]').find((t) => t.textContent === 'Opened') as HTMLElement;
    await act(async () => openedTab.click());

    const table = container.querySelector('[data-testid="opened-boxes"]');
    expect([...(table?.querySelectorAll('th') ?? [])].map((th) => th.textContent)).toEqual([
      'Reward',
      'Rarity',
      'From',
      'When',
    ]);
    expect([...(table?.querySelectorAll('tbody td') ?? [])].map((td) => td.textContent)).toEqual([
      'Frog',
      'Rare',
      'Pink Mystery Hat Box',
      'Nov 3, 2026',
    ]);
    expect(table?.querySelector('img')?.getAttribute('data-src')).toBe('frog.png');
  });
});
