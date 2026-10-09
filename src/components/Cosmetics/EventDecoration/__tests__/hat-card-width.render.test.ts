// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';

/**
 * The card width a preview declares reaches the hat it draws: PreviewCard -> MasonryCard ->
 * TwCosmeticWrapper -> EventDecorationOverlay. A link dropped anywhere along the way draws a
 * feed-sized hat on a small card, which the layout's own tests cannot see.
 */

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy(),
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia: () => null,
  EdgeMedia2: () => null,
}));

const { PreviewCard } = await import('~/components/Modals/CardDecorationModal');
const { getEventDecorationClearLeftCss, getHatLayout, HAT_LOOK_CARD_WIDTH, HAT_PLAIN_CARD_NUDGE } =
  await import('~/components/Cosmetics/EventDecoration/event-decoration-placement');

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

const hat = { type: 'hat', event: 'birthday2026', url: 'u' };
const image = { id: 1, url: 'x', width: 512, height: 640, name: null, type: 'image' } as never;

function hatWidth(width?: number) {
  act(() => root?.unmount());
  host?.remove();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(PreviewCard, { image, hat, width })
      )
    )
  );
  const button = host.querySelector<HTMLElement>('button[data-event-decoration="hat"]');
  return button ? parseFloat(button.style.width) : undefined;
}

// What corner content (the creator's avatar, the browsing-level chip) steps clear of.
const clearLeft = () =>
  host
    ?.querySelector<HTMLElement>('div[data-event-decoration="hat"]')
    ?.style.getPropertyValue('--event-decoration-clear-left');

describe('PreviewCard width', () => {
  it('draws the hat at the size the layout gives its card width', () => {
    const half = HAT_LOOK_CARD_WIDTH / 2;
    expect(hatWidth(half)).toBeCloseTo(
      getHatLayout('corner', undefined, Infinity, HAT_PLAIN_CARD_NUDGE, half).width,
      6
    );
  });

  it('clears corner content by the smaller hat', () => {
    const half = HAT_LOOK_CARD_WIDTH / 2;
    hatWidth(half);
    const small = clearLeft();
    expect(small).toBe(getEventDecorationClearLeftCss(hat, 'corner', HAT_PLAIN_CARD_NUDGE, half));
    hatWidth();
    expect(clearLeft()).toBe(getEventDecorationClearLeftCss(hat, 'corner', HAT_PLAIN_CARD_NUDGE));
    expect(clearLeft()).not.toBe(small);
  });

  // Positive control: without a width the same card draws the feed-sized hat, so the arm above
  // cannot pass by drawing every hat small.
  it('draws the feed size without one', () => {
    const feed = getHatLayout('corner', undefined, Infinity, HAT_PLAIN_CARD_NUDGE).width;
    expect(hatWidth()).toBeCloseTo(feed, 6);
    expect(hatWidth(HAT_LOOK_CARD_WIDTH / 2)).toBeCloseTo(feed / 2, 6);
  });
});
