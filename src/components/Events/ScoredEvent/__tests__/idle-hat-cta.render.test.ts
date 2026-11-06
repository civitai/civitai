// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as EventsUtils from '~/components/Events/events.utils';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';

const act = (React as unknown as { act: (cb: () => void) => void }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'cosmeticShop.getShop': { useQuery: () => ({ data: [], isLoading: false }) },
  }),
}));
vi.mock('~/components/Events/events.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof EventsUtils>()),
  useTeamColor: () => () => '#339af0',
}));
const { trigger } = vi.hoisted(() => ({ trigger: vi.fn() }));
vi.mock('~/components/Dialog/dialogStore', () => ({ dialogStore: { trigger } }));
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({ EdgeMedia: () => null }));
vi.mock('~/components/Events/ScoredEvent/EventContentThumb', () => ({
  EventContentThumb: () => null,
}));
vi.mock('~/components/Metrics/AnimatedCount', () => ({
  AnimatedCount: ({ value }: { value: number }) => React.createElement('span', null, value),
}));

const { MyEventHats } = await import('~/components/Events/ScoredEvent/MyEventHats');

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  trigger.mockClear();
});

const hat = (over: Record<string, unknown> = {}) => ({
  cosmeticId: 31,
  claimKey: 'c',
  name: 'Party Cap - Blue',
  data: { url: 'hat-art' },
  placedOn: null,
  placedAt: null,
  movableAt: null,
  moveCooldownLeftMs: 0,
  points: 0,
  impressions: 0,
  reactions: 0,
  ...over,
});
const placed = { entityType: 'Image', entityId: 9, title: null, image: null };

function render(hats: unknown[], ended = false) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(MyEventHats, {
          event: 'birthday2026',
          hats: hats as React.ComponentProps<typeof MyEventHats>['hats'],
          fetchedAt: Date.now(),
          teamColor: '#339af0',
          ended,
        })
      )
    )
  );
  return host;
}
const cta = (el: Element) => el.querySelector<HTMLElement>('[data-testid="idle-hat-cta"]');

describe('the idle hat call to action', () => {
  it('shows when none of the viewer hats is on anything, and opens the picker for one', () => {
    const el = render([hat(), hat({ cosmeticId: 32 })]);
    const box = cta(el);
    expect(box?.textContent).toContain('Put your hat on something');
    act(() => box!.querySelector('button')!.click());
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger.mock.calls[0][0].props.hat.cosmeticId).toBe(31);
  });

  it('hides once any hat is placed', () => {
    expect(cta(render([hat(), hat({ cosmeticId: 32, placedOn: placed })]))).toBeNull();
  });

  it('offers a hat that can move now, and hides while every hat is cooling down', () => {
    const cooling = { moveCooldownLeftMs: 10 * 60_000 };
    const box = cta(render([hat(cooling), hat({ cosmeticId: 32 })]));
    act(() => box!.querySelector('button')!.click());
    expect(trigger.mock.calls[0][0].props.hat.cosmeticId).toBe(32);
    act(() => root?.unmount());
    host?.remove();
    expect(cta(render([hat(cooling)]))).toBeNull();
  });

  it('hides after the event ends', () => {
    expect(cta(render([hat()], true))).toBeNull();
  });
});
