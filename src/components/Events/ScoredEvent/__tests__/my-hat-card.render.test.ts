// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('~/components/Events/ScoredEvent/EventContentThumb', () => ({
  EventContentThumb: () => React.createElement('div', { 'data-testid': 'thumb' }),
}));
vi.mock('~/components/Events/ScoredEvent/HatArt', () => ({ HatArt: () => null }));
vi.mock('~/components/Events/ScoredEvent/HatStats', () => ({ HatStats: () => null }));

import type { MyHat } from '../MyHatCard';
import { MyHatCard } from '../MyHatCard';

const hat = (placed: boolean) =>
  ({
    name: 'Party Hat',
    cosmeticId: 1,
    claimKey: 'a',
    data: { url: 'hat.png' },
    placedOn: placed ? { entityType: 'Image', entityId: 5, image: null } : null,
  } as unknown as MyHat);

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const render = async (props: React.ComponentProps<typeof MyHatCard>) => {
  await act(async () =>
    root.render(React.createElement(MantineProvider, null, React.createElement(MyHatCard, props)))
  );
};
const button = () => container.querySelector('button');

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('MyHatCard', () => {
  it('shows no action without onPlace', async () => {
    await render({ hat: hat(false), color: '#f06595', minutesLeft: 0 });

    expect(button()).toBeNull();
  });

  it('offers Place it on a free hat and Move on a placed one, each calling onPlace', async () => {
    const onPlace = vi.fn();
    await render({ hat: hat(false), color: '#f06595', minutesLeft: 0, onPlace });
    expect(button()?.textContent).toBe('Place it');

    await render({ hat: hat(true), color: '#f06595', minutesLeft: 0, onPlace });
    expect(button()?.textContent).toBe('Move');
    await act(async () => button()?.click());
    expect(onPlace).toHaveBeenCalledTimes(1);
  });

  it('holds the action until the move cooldown ends, and says when', async () => {
    await render({ hat: hat(true), color: '#f06595', minutesLeft: 3, onPlace: vi.fn() });

    expect(button()?.disabled).toBe(true);
    expect(container.textContent).toContain('Can move in 3 min');
  });
});
