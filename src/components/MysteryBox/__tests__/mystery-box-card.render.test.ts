// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

/**
 * Where the box shows on the event page and what its card offers: at the head of the team shelf,
 * under Your hats once the event has ended and a box is still held, and nowhere with the flag off.
 */

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { state } = vi.hoisted(() => ({
  state: {
    boxes: [] as unknown[],
    flags: { mysteryBox: true } as Record<string, boolean> | null,
    trigger: vi.fn(),
  },
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'mysteryBox.getForEvent': {
      useQuery: (_: unknown, opts?: { enabled?: boolean }) => ({
        data: opts?.enabled === false ? undefined : state.boxes,
        isLoading: false,
      }),
    },
    'cosmeticShop.getShop': { useQuery: () => ({ data: [], isLoading: false }) },
  }),
}));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useOptionalFeatureFlags: () => state.flags,
}));
vi.mock('~/components/Dialog/dialogStore', () => ({ dialogStore: { trigger: state.trigger } }));
vi.mock('~/components/MysteryBox/MysteryBoxModal', () => ({
  default: function MysteryBoxModal() {
    return null;
  },
}));
vi.mock('~/components/Buzz/BuzzTransactionButton', () => ({
  BuzzTransactionButton: ({
    label,
    onPerformTransaction,
    ...rest
  }: {
    label: string;
    onPerformTransaction: () => void;
    'data-testid'?: string;
  }) =>
    React.createElement(
      'button',
      { onClick: onPerformTransaction, 'data-testid': rest['data-testid'] },
      label
    ),
}));
vi.mock('~/components/Buzz/useAvailableBuzz', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAvailableBuzz: () => ['yellow'],
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia: ({ src }: { src: string }) => React.createElement('img', { 'data-src': src }),
}));
vi.mock('~/components/Events/events.utils', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTeamColor: () => () => '#339af0',
}));

import { MysteryBoxCard } from '../MysteryBoxCard';
import { TeamHatShelf } from '~/components/Events/ScoredEvent/TeamHatShelf';
import { MyEventHats } from '~/components/Events/ScoredEvent/MyEventHats';
import type { MysteryBoxView } from '../mystery-box.utils';

const content = (contentId: number, left = true) => ({
  contentId,
  tierId: 7,
  cosmeticId: 1000 + contentId,
  name: `Hat ${contentId}`,
  url: null,
  fit: null,
  left,
});
const box = (overrides: Partial<MysteryBoxView> = {}): MysteryBoxView => ({
  boxDefinitionId: 9,
  name: 'Birthday Box',
  description: null,
  version: 3,
  team: 'Blue',
  art: null,
  listing: { shopItemId: 42, title: 'Birthday Box', unitAmount: 500, availableTo: null },
  tiers: [{ id: 7, key: 'common', name: 'Common', color: null, weight: 1, sortOrder: 0 }],
  contents: [content(1), content(2)],
  heldBoxItemIds: [],
  ...overrides,
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const render = async (node: React.ReactElement) => {
  await act(async () => root.render(React.createElement(MantineProvider, null, node)));
};
const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`);
const triggeredStart = () =>
  (state.trigger.mock.calls.at(-1)?.[0] as { props: { start?: string } } | undefined)?.props.start;

beforeEach(() => {
  state.trigger.mockReset();
  state.boxes = [];
  state.flags = { mysteryBox: true };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('MysteryBoxCard', () => {
  it('offers Buy and open, which opens the modal ready to buy', async () => {
    await render(React.createElement(MysteryBoxCard, { event: 'e', view: box(), color: '#000' }));

    expect(byTestId('box-card-open')).toBeNull();
    await act(async () => (byTestId('box-card-buy') as HTMLButtonElement).click());
    expect(triggeredStart()).toBe('buy');
  });

  it('offers Open your box first when one is held', async () => {
    await render(
      React.createElement(MysteryBoxCard, {
        event: 'e',
        view: box({ heldBoxItemIds: ['501'] }),
        color: '#000',
      })
    );

    expect(byTestId('box-card-buy')).toBeNull();
    await act(async () => (byTestId('box-card-open') as HTMLButtonElement).click());
    expect(triggeredStart()).toBe('open');
  });

  it('looks inside without starting anything', async () => {
    await render(React.createElement(MysteryBoxCard, { event: 'e', view: box(), color: '#000' }));

    await act(async () => (byTestId('box-look-inside') as HTMLButtonElement).click());
    expect(state.trigger).toHaveBeenCalledTimes(1);
    expect(triggeredStart()).toBeUndefined();
  });

  it('says Complete, with nothing to buy or open, once everything is collected', async () => {
    await render(
      React.createElement(MysteryBoxCard, {
        event: 'e',
        view: box({ contents: [content(1, false), content(2, false)] }),
        color: '#000',
      })
    );

    expect(container.textContent).toContain('Complete');
    expect(container.textContent).toContain('2 / 2 collected');
    expect(byTestId('box-card-buy')).toBeNull();
    expect(byTestId('box-card-open')).toBeNull();
  });
});

describe('where the box shows', () => {
  it('leads the team shelf', async () => {
    state.boxes = [box()];
    await render(React.createElement(TeamHatShelf, { event: 'birthday2026', team: 'Blue' }));
    expect(container.querySelectorAll('[data-testid="mystery-box-card"]')).toHaveLength(1);
  });

  it('shows nowhere with the flag off, or outside the flags provider', async () => {
    state.boxes = [box()];
    state.flags = { mysteryBox: false };
    await render(React.createElement(TeamHatShelf, { event: 'birthday2026', team: 'Blue' }));
    expect(byTestId('mystery-box-card')).toBeNull();

    state.flags = null;
    await render(React.createElement(TeamHatShelf, { event: 'birthday2026', team: 'Blue' }));
    expect(byTestId('mystery-box-card')).toBeNull();
  });

  it('shows a held box under Your hats once the event has ended, and not before', async () => {
    state.boxes = [box({ listing: null, heldBoxItemIds: ['501'] })];
    const hats = (ended: boolean) =>
      React.createElement(MyEventHats, {
        event: 'birthday2026',
        hats: [],
        fetchedAt: Date.now(),
        teamColor: '#339af0',
        ended,
      });

    await render(hats(false));
    expect(byTestId('mystery-box-card')).toBeNull();

    await render(hats(true));
    expect(byTestId('mystery-box-card')).not.toBeNull();
    expect(byTestId('box-card-open')).not.toBeNull();
  });

  it('adds the box to Get another hat while it is on sale', async () => {
    state.boxes = [box()];
    await render(
      React.createElement(MyEventHats, {
        event: 'birthday2026',
        hats: [],
        fetchedAt: Date.now(),
        teamColor: '#339af0',
        ended: false,
      })
    );
    expect(byTestId('get-another-hat-box')?.textContent).toContain('500');
  });
});
