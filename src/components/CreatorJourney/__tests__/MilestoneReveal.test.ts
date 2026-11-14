// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import type * as TrpcModule from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

const trpcMocks = vi.hoisted(() => ({ mutate: vi.fn(), setData: vi.fn() }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy(
    { 'creatorJourney.markRevealsSeen': { useMutation: () => ({ mutate: trpcMocks.mutate }) } },
    { useUtils: () => ({ creatorJourney: { getMine: { setData: trpcMocks.setData } } }) }
  ),
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({ EdgeMedia: () => null }));

import { MilestoneReveals } from '~/components/CreatorJourney/MilestoneReveal';

const act = (React as unknown as { act: (callback: () => void) => void }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Reveal = React.ComponentProps<typeof MilestoneReveals>['reveals'][number];
const reveal = (key: string, rarity: number | null): Reveal => ({
  key,
  track: 'create',
  threshold: 1,
  name: key,
  description: null,
  hint: null,
  badgeUrl: null,
  special: false,
  rarity,
});

let root: Root | null = null;
let container: HTMLElement | null = null;

function mount(reveals: Reveal[]) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      React.createElement(
        MantineProvider,
        { env: 'test' },
        React.createElement(MilestoneReveals, { reveals })
      )
    )
  );
}

const button = (label: string) =>
  [...document.body.querySelectorAll('button')].find((el) => el.textContent === label);

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  trpcMocks.mutate.mockReset();
  trpcMocks.setData.mockReset();
});

describe('dismissing reveals', () => {
  // The journey query never refetches by itself, so a dismissal that only lived in the component
  // would replay on the next visit.
  it('marks each dismissed reveal seen and drops it from the cached journey', () => {
    mount([reveal('epic', 0.5), reveal('rare', 4), reveal('common', 30)]);

    act(() => button('Nice')?.click());
    expect(trpcMocks.mutate).toHaveBeenLastCalledWith({ keys: ['epic'] });

    act(() => button('Got it')?.click());
    expect(trpcMocks.mutate).toHaveBeenLastCalledWith({ keys: ['rare', 'common'] });
    expect(trpcMocks.mutate).toHaveBeenCalledTimes(2);

    const journey = { reveals: [reveal('epic', 0.5), reveal('rare', 4), reveal('common', 30)] };
    const after = trpcMocks.setData.mock.calls.reduce(
      (current, [, update]) => update(current),
      journey
    );
    expect(after.reveals).toEqual([]);
  });
});
