// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import type * as OpenHook from '../useMysteryBoxOpen';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { state } = vi.hoisted(() => ({
  state: {
    forEvent: vi.fn(),
    held: vi.fn(),
    shop: vi.fn(),
    openHeld: vi.fn(),
    views: [] as unknown[],
    phase: 'idle' as string,
  },
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'mysteryBox.getForEvent': {
      useQuery: (input: unknown, opts?: { enabled?: boolean }) => {
        state.forEvent(input, opts);
        return { data: opts?.enabled === false ? undefined : state.views, isLoading: false };
      },
    },
    'mysteryBox.getHeld': {
      useQuery: (input: unknown, opts?: { enabled?: boolean }) => {
        state.held(input, opts);
        return { data: opts?.enabled === false ? undefined : state.views, isLoading: false };
      },
    },
    'cosmeticShop.getShop': {
      useQuery: (input: unknown, opts?: { enabled?: boolean }) => {
        state.shop(input, opts);
        return { data: [], isLoading: false };
      },
    },
  }),
}));
vi.mock('../useMysteryBoxOpen', async (importOriginal) => ({
  ...(await importOriginal<typeof OpenHook>()),
  useMysteryBoxOpen: () => ({
    phase: state.phase,
    result:
      state.phase === 'revealed'
        ? {
            boxItemId: '502',
            boxDefinitionId: 9,
            boxVersion: 3,
            tierId: 7,
            contentId: 2,
            rewardDefinitionId: 102,
            rewardType: 'cosmetic',
            cosmeticId: 1002,
            odds: { tierWeight: 1, eligibleWeight: 1, tierPoolSize: 2 },
            replayed: false,
          }
        : undefined,
    busy: false,
    buyAndOpen: vi.fn(),
    openHeld: state.openHeld,
    reset: vi.fn(),
  }),
}));
vi.mock('~/components/Dialog/DialogProvider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useDialogContext: () => ({ opened: true, onClose: vi.fn(), zIndex: 200 }),
}));
vi.mock('~/components/Buzz/useAvailableBuzz', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAvailableBuzz: () => ['yellow'],
}));
vi.mock('~/components/Buzz/BuzzTransactionButton', () => ({
  BuzzTransactionButton: () => null,
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia: ({ src }: { src: string }) => React.createElement('img', { 'data-src': src }),
}));
vi.mock('~/hooks/useIsMobile', () => ({ useIsMobile: () => false }));

import MysteryBoxModal from '../MysteryBoxModal';
import type { HeldMysteryBox, MysteryBoxSource } from '../mystery-box.utils';

const view = (overrides: Partial<HeldMysteryBox> = {}): HeldMysteryBox => ({
  boxDefinitionId: 9,
  name: 'Box',
  description: null,
  version: 3,
  team: undefined,
  art: null,
  listing: null,
  tiers: [{ id: 7, key: 'common', name: 'Common', color: null, weight: 1, sortOrder: 0 }],
  contents: [
    { contentId: 1, tierId: 7, cosmeticId: 1001, name: 'A', url: null, fit: null, left: true },
    { contentId: 2, tierId: 7, cosmeticId: 1002, name: 'B', url: null, fit: null, left: false },
  ],
  heldBoxItemIds: ['501', '502'],
  event: null,
  heldItems: [
    { id: '501', acquiredAt: new Date(2026, 10, 1) },
    { id: '502', acquiredAt: new Date(2026, 10, 2) },
  ],
  ...overrides,
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const render = async (source: MysteryBoxSource, props: Record<string, unknown> = {}) => {
  await act(async () =>
    root.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(MysteryBoxModal, {
          source,
          boxDefinitionId: 9,
          color: '#000',
          ...props,
        })
      )
    )
  );
};
const placeButton = () => document.body.querySelector('[data-testid="box-place"]');

beforeEach(() => {
  for (const spy of [state.forEvent, state.held, state.shop, state.openHeld]) spy.mockReset();
  state.views = [view()];
  state.phase = 'idle';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('MysteryBoxModal opened from the Inventory', () => {
  it("reads the Inventory's boxes, not an event's", async () => {
    await render({ inventory: true });

    expect(state.held.mock.calls.at(-1)?.[1]).toEqual({ enabled: true });
    expect(state.forEvent.mock.calls.at(-1)?.[1]).toEqual({ enabled: false });
    expect(document.body.textContent).toContain('Box');
  });

  it('opens nothing on its own when only shown', async () => {
    await render({ inventory: true }, { boxItemId: '502' });

    expect(state.openHeld).not.toHaveBeenCalled();
  });

  it('opens the box the viewer picked', async () => {
    await render({ inventory: true }, { start: 'open', boxItemId: '502' });

    expect(state.openHeld).toHaveBeenCalledTimes(1);
    expect(state.openHeld.mock.calls[0][1]).toBe('502');
  });

  it('asks no shelf for a box with no event, and offers no post to put its reward on', async () => {
    state.phase = 'revealed';
    await render({ inventory: true });

    expect(state.shop.mock.calls.at(-1)?.[1]).toEqual({ enabled: false });
    expect(document.body.querySelector('[data-testid="box-stage"]')).not.toBeNull();
    expect(placeButton()).toBeNull();
  });

  it("asks the event's shelf, and offers the post, for an event box", async () => {
    state.views = [view({ event: 'birthday2026', team: 'Blue' })];
    state.phase = 'revealed';
    await render({ inventory: true });

    expect(state.shop.mock.calls.at(-1)).toEqual([{ event: 'birthday2026' }, { enabled: true }]);
    expect(placeButton()).not.toBeNull();
  });
});

describe('MysteryBoxModal opened from an event page', () => {
  it("reads the event's boxes, not the Inventory's", async () => {
    await render({ event: 'birthday2026' });

    expect(state.forEvent.mock.calls.at(-1)).toEqual([
      { event: 'birthday2026' },
      { enabled: true },
    ]);
    expect(state.held.mock.calls.at(-1)?.[1]).toEqual({ enabled: false });
  });
});
