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

const VIEWER = 42;

const { state } = vi.hoisted(() => ({
  state: {
    cosmetics: undefined as unknown,
    balances: [] as { cosmeticId: number; remaining: number | null }[],
    hats: {} as Record<string, unknown[] | 'error'>,
    hatReads: [] as string[],
    update: vi.fn(),
    updateOptions: undefined as undefined | { onSuccess: () => Promise<unknown> },
    invalidateCosmetics: vi.fn(),
    invalidateProfile: vi.fn(),
    invalidateCreator: vi.fn(),
    trigger: vi.fn(),
  },
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy(
    {
      'user.getCosmetics': { useQuery: () => ({ data: state.cosmetics, isLoading: false }) },
      'cosmetic.getStickerBalances': { useQuery: () => ({ data: state.balances }) },
      'event.getMyHats': {
        useQuery: ({ event }: { event: string }) => {
          state.hatReads.push(event);
          const hats = state.hats[event];
          return hats === 'error'
            ? { data: undefined, isLoading: false, isError: true, dataUpdatedAt: 0 }
            : { data: hats, isLoading: false, isError: false, dataUpdatedAt: Date.now() };
        },
      },
      'user.update': {
        useMutation: (options: { onSuccess: () => Promise<unknown> }) => {
          state.updateOptions = options;
          return { mutate: state.update, isPending: false, variables: undefined };
        },
      },
    },
    {
      useUtils: () => ({
        user: {
          getCosmetics: { invalidate: state.invalidateCosmetics },
          getCreator: { invalidate: state.invalidateCreator },
        },
        userProfile: { get: { invalidate: state.invalidateProfile } },
      }),
    }
  ),
}));
vi.mock('~/components/Events/events.utils', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTeamColor: () => (team: string) => team === 'Pink' ? '#f06595' : undefined,
}));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: VIEWER, refresh: vi.fn() }),
}));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useOptionalFeatureFlags: () => ({ mysteryBox: true }),
}));
vi.mock('~/components/Notifications/notifications.utils', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useQueryNotificationsCount: () => ({ unopenedBoxes: 2 }),
}));
vi.mock('~/components/Dialog/dialogStore', () => ({ dialogStore: { trigger: state.trigger } }));
vi.mock('~/components/Events/ScoredEvent/PlaceHatModal', () => ({
  default: function PlaceHatModal() {
    return null;
  },
}));
vi.mock('~/components/Events/ScoredEvent/MyHatCard', () => ({
  MyHatCard: ({
    hat,
    color,
    minutesLeft,
    onPlace,
  }: {
    hat: { name: string };
    color: string;
    minutesLeft: number;
    onPlace?: () => void;
  }) =>
    React.createElement(
      'div',
      { 'data-testid': 'my-hat', 'data-color': color, 'data-minutes-left': minutesLeft },
      hat.name,
      onPlace && React.createElement('button', { onClick: onPlace }, 'Place it')
    ),
}));
vi.mock('~/components/Shop/CosmeticSample', () => ({
  CosmeticSample: ({ cosmetic }: { cosmetic: { id: number } }) =>
    React.createElement('span', { 'data-cosmetic-id': cosmetic.id }),
}));
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));

import { InventoryLayout } from '../InventoryLayout';

type Item = {
  id: number;
  name: string;
  data?: unknown;
  equipped?: boolean;
  withheld?: boolean;
  claimKey?: string;
  equippedToType?: string | null;
  equippedToId?: number | null;
};
const item = ({ claimKey = 'claimed', data = {}, ...rest }: Item) => ({
  type: 'Badge',
  claimKey,
  data,
  equipped: false,
  inUse: false,
  equippedToType: null,
  equippedToId: null,
  ...rest,
});
const hat = (id: number, event: string, claimKey = 'claimed') =>
  item({ id, name: `Hat ${id}`, claimKey, data: { type: 'hat', event, url: `hat-${id}.png` } });
const cosmetics = (groups: Partial<Record<string, ReturnType<typeof item>[]>> = {}) => ({
  badges: [],
  nameplates: [],
  profileDecorations: [],
  profileBackground: [],
  contentDecorations: [],
  sticker: [],
  cardDecorations: [],
  ...groups,
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const render = async (typeKey: string) => {
  await act(async () =>
    root.render(
      React.createElement(MantineProvider, null, React.createElement(InventoryLayout, { typeKey }))
    )
  );
};
const all = (selector: string) => [...container.querySelectorAll(selector)];
const buttons = (text: string) =>
  all('button').filter((b) => b.textContent === text) as HTMLButtonElement[];

beforeEach(() => {
  state.cosmetics = cosmetics();
  state.balances = [];
  state.hats = {};
  state.hatReads = [];
  state.update.mockReset();
  state.updateOptions = undefined;
  state.invalidateCosmetics.mockReset();
  state.invalidateProfile.mockReset();
  state.invalidateCreator.mockReset();
  state.trigger.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('Inventory nav', () => {
  it('lists every kind, counted from the one cosmetics read: hats apart from frames, stickers once each', async () => {
    state.cosmetics = cosmetics({
      badges: [item({ id: 1, name: 'A' }), item({ id: 2, name: 'B' })],
      contentDecorations: [
        hat(10, 'birthday2026', 'a'),
        hat(10, 'birthday2026', 'b'),
        item({ id: 20, name: 'Frame' }),
      ],
      sticker: [
        item({ id: 30, name: 'S', claimKey: 'x' }),
        item({ id: 30, name: 'S', claimKey: 'y' }),
      ],
    });
    await render('boxes');

    const links = all('nav[aria-label="Inventory"] a');
    expect(links.map((a) => [a.getAttribute('href'), a.textContent])).toEqual([
      ['/user/inventory/boxes', 'Boxes2'],
      ['/user/inventory/hats', 'Hats2'],
      ['/user/inventory/badges', 'Badges2'],
      ['/user/inventory/avatar-decorations', 'Avatar decorations'],
      ['/user/inventory/nameplates', 'Nameplates'],
      ['/user/inventory/backgrounds', 'Profile backgrounds'],
      ['/user/inventory/card-glows', 'Card glows'],
      ['/user/inventory/frames', 'Content frames1'],
      ['/user/inventory/stickers', 'Stickers1'],
    ]);
  });
});

describe('Inventory equip pages', () => {
  // Customize profile sends every slot; this page must send only its own, or equipping a badge
  // would take off the viewer's nameplate, background and the rest.
  it('equips a badge by sending only the badge slot', async () => {
    state.cosmetics = cosmetics({
      badges: [item({ id: 1, name: 'Worn', equipped: true }), item({ id: 2, name: 'Spare' })],
    });
    await render('badges');

    expect(all('[data-testid="inventory-equippable"]').map((c) => c.textContent)).toEqual([
      'WornEquippedUnequip',
      'SpareEquip',
    ]);
    await act(async () => buttons('Equip')[0].click());
    await act(async () => buttons('Unequip')[0].click());
    expect(state.update.mock.calls.map(([input]) => input)).toEqual([
      { id: VIEWER, badgeId: 2 },
      { id: VIEWER, badgeId: null },
    ]);
  });

  it.each([
    ['avatar-decorations', 'profileDecorations', 'profileDecorationId'],
    ['nameplates', 'nameplates', 'nameplateId'],
    ['backgrounds', 'profileBackground', 'profileBackgroundId'],
    ['card-glows', 'cardDecorations', 'cardDecorationId'],
  ])('%s equips through %s into %s alone', async (page, group, slot) => {
    state.cosmetics = cosmetics({ [group]: [item({ id: 7, name: 'One' })] });
    await render(page);

    await act(async () => buttons('Equip')[0].click());
    expect(state.update.mock.calls.map(([input]) => input)).toEqual([{ id: VIEWER, [slot]: 7 }]);
  });

  it('offers no equip for an item in review, but still lets a worn one come off', async () => {
    state.cosmetics = cosmetics({
      profileDecorations: [
        item({ id: 1, name: 'Sent back', withheld: true }),
        item({ id: 2, name: 'Worn before', withheld: true, equipped: true }),
        item({ id: 3, name: 'Live' }),
      ],
    });
    await render('avatar-decorations');

    expect(all('[data-testid="inventory-equippable"]').map((c) => c.textContent)).toEqual([
      'Sent backIn review, not equipable',
      'Worn beforeEquippedUnequip',
      'LiveEquip',
    ]);
  });

  it('says so when the viewer owns none, as every card glow page does today', async () => {
    await render('card-glows');

    expect(container.textContent).toContain("You don't have any card glows yet.");
  });

  // A later copy is unstamped, and the page lists one card per cosmetic.
  it('shows a cosmetic as equipped when a later, unstamped copy is listed first', async () => {
    state.cosmetics = cosmetics({
      badges: [
        item({ id: 1, name: 'Worn', claimKey: 'later' }),
        item({ id: 1, name: 'Worn', claimKey: 'first', equipped: true }),
      ],
    });
    await render('badges');

    expect(all('[data-testid="inventory-equippable"]').map((c) => c.textContent)).toEqual([
      'WornEquippedUnequip',
    ]);
  });

  it('refreshes the cosmetics, the profile and the creator card once an equip lands', async () => {
    state.cosmetics = cosmetics({ badges: [item({ id: 2, name: 'Spare' })] });
    await render('badges');
    await act(async () => {
      await state.updateOptions?.onSuccess();
    });

    expect(state.invalidateCosmetics).toHaveBeenCalledTimes(1);
    expect(state.invalidateProfile).toHaveBeenCalledTimes(1);
    expect(state.invalidateCreator).toHaveBeenCalledWith({ id: VIEWER });
  });
});

describe('Inventory frames', () => {
  it("links each frame to the content it's on and leaves out hats", async () => {
    state.cosmetics = cosmetics({
      contentDecorations: [
        item({ id: 1, name: 'On a post', equippedToType: 'Post', equippedToId: 12 }),
        item({
          id: 2,
          name: 'On a model',
          claimKey: 'k',
          equippedToType: 'Model',
          equippedToId: 3,
        }),
        item({ id: 3, name: 'Spare' }),
        hat(4, 'birthday2026'),
        item({ id: 5, name: 'Sent back', withheld: true }),
      ],
    });
    await render('frames');

    const cards = all('[data-testid="inventory-frame"]');
    expect(cards.map((c) => c.querySelector('a')?.getAttribute('href') ?? c.textContent)).toEqual([
      '/posts/12',
      '/models/3',
      'SpareNot in use',
      'Sent backIn review, not equipable',
    ]);
  });
});

describe('Inventory stickers', () => {
  it('shows the uses left on each sticker, summed across its holdings by the balance read', async () => {
    state.cosmetics = cosmetics({
      sticker: [
        item({ id: 1, name: 'Few' }),
        item({ id: 2, name: 'One' }),
        item({ id: 3, name: 'Forever' }),
      ],
    });
    state.balances = [
      { cosmeticId: 1, remaining: 3 },
      { cosmeticId: 2, remaining: 1 },
      { cosmeticId: 3, remaining: null },
    ];
    await render('stickers');

    expect(all('[data-testid="inventory-sticker"]').map((c) => c.textContent)).toEqual([
      'Few3 uses left',
      'One1 use left',
      'ForeverUnlimited',
    ]);
  });
});

describe('Inventory hats', () => {
  const myHat = (name: string, { team = 'Pink', cooldownMs = 0 } = {}) => ({
    name,
    cosmeticId: 1,
    claimKey: name,
    data: { team },
    moveCooldownLeftMs: cooldownMs,
  });
  const hatCards = () =>
    all('[data-testid="my-hat"]').map((c) => ({
      text: c.textContent,
      color: c.getAttribute('data-color'),
      minutesLeft: c.getAttribute('data-minutes-left'),
    }));

  it('reads each event once and places a hat with that event and its hats', async () => {
    state.cosmetics = cosmetics({
      contentDecorations: [hat(1, 'birthday2026', 'a'), hat(2, 'birthday2026', 'b')],
    });
    state.hats = { birthday2026: [myHat('First'), myHat('Second')] };
    await render('hats');

    expect([...new Set(state.hatReads)]).toEqual(['birthday2026']);
    expect(hatCards().map((c) => c.text)).toEqual(['FirstPlace it', 'SecondPlace it']);
    await act(async () => buttons('Place it')[1].click());
    const { props } = state.trigger.mock.calls[0][0] as { props: Record<string, unknown> };
    expect(props).toEqual({
      event: 'birthday2026',
      hat: myHat('Second'),
      myHats: [myHat('First'), myHat('Second')],
    });
  });

  it("gives each hat its team's colour and the server's remaining move cooldown", async () => {
    state.cosmetics = cosmetics({ contentDecorations: [hat(1, 'birthday2026')] });
    state.hats = {
      birthday2026: [myHat('Pink', { cooldownMs: 5 * 60_000 }), myHat('Teamless', { team: '' })],
    };
    await render('hats');

    expect(hatCards().map(({ color, minutesLeft }) => ({ color, minutesLeft }))).toEqual([
      { color: '#f06595', minutesLeft: '5' },
      { color: 'var(--mantine-color-blue-5)', minutesLeft: '0' },
    ]);
  });

  // No definition: the server refuses placement. Unreadable event: it refuses the read. Both still
  // list the hats.
  it('lists hats it cannot place, with no action', async () => {
    state.cosmetics = cosmetics({
      contentDecorations: [hat(1, 'retired2024'), hat(2, 'hidden2026')],
    });
    state.hats = { retired2024: [myHat('Old')], hidden2026: 'error' };
    await render('hats');

    expect(
      all('[data-testid="inventory-event-hats"]').map((s) => s.getAttribute('data-event'))
    ).toEqual(['retired2024', 'hidden2026']);
    expect(hatCards().map((c) => c.text)).toEqual(['Old']);
    expect(all('[data-testid="inventory-unplaceable-hat"]').map((c) => c.textContent)).toEqual([
      'Hat 2',
    ]);
    expect(buttons('Place it')).toEqual([]);
    // No link for an event the viewer can't open.
    expect(
      all('[data-testid="inventory-event-hats"]').map(
        (s) => s.querySelector('a')?.getAttribute('href') ?? null
      )
    ).toEqual(['/events/retired2024', null]);
  });
});
