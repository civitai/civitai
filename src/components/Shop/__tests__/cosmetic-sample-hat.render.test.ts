// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CosmeticType } from '~/shared/utils/prisma/enums';

/**
 * A hat's shop sample (the shop grid, and the buy dialog the event page opens) wears the hat on a
 * placeholder card. Before, the card was the colour of the shop card behind it, so the hat floated
 * off to the left of nothing (Ellie review, 2026-10-09).
 */

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia: () => null,
  EdgeMedia2: () => null,
}));

const { CosmeticSample } = await import('~/components/Shop/CosmeticSample');

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

function render(data: unknown, size?: 'sm' | 'md' | 'lg') {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const cosmetic = { id: 1, name: 'Party Cap', type: CosmeticType.ContentDecoration, data };
  act(() =>
    root!.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(CosmeticSample, { cosmetic, size } as React.ComponentProps<
          typeof CosmeticSample
        >)
      )
    )
  );
  return host;
}

const HAT = { type: 'hat', event: 'birthday2026', url: 'hat-blue', team: 'Blue' };
const hatButton = (el: HTMLElement) =>
  el.querySelector<HTMLElement>('button[data-event-decoration="hat"]');

describe('a hat in the shop', () => {
  it('is worn on a placeholder card, drawn by the feed card wrapper', () => {
    const sample = render(HAT, 'lg').querySelector<HTMLElement>('[data-testid="hat-sample"]')!;
    const wrapper = sample.querySelector<HTMLElement>('[data-event-decoration="hat"]')!;
    const [card, hat] = [...wrapper.children];
    // The card is a shade the shop card is not, so it reads as content under the hat.
    expect(card.className.split(' ')).toEqual(
      expect.arrayContaining(['aspect-square', 'bg-gray-2', 'dark:bg-dark-4'])
    );
    expect(card.children).toHaveLength(2);
    expect(hat).toBe(hatButton(sample));
  });

  it('wears the hat at full feed size in the large sample, and shrinks it in the small ones', () => {
    const width = (size: 'sm' | 'lg') => {
      const w = parseFloat(hatButton(render(HAT, size))!.style.width);
      act(() => root?.unmount());
      host?.remove();
      return w;
    };
    const [large, small] = [width('lg'), width('sm')];
    expect(large).toBeGreaterThan(0);
    expect(small).toBeLessThan(large / 2);
  });

  it('leaves room past the corner for the hat, and does not grow it on hover', () => {
    const sample = render(HAT, 'lg').querySelector<HTMLElement>('[data-testid="hat-sample"]')!;
    expect(sample.style.paddingTop).toBe('28px');
    expect(sample.style.getPropertyValue('--event-decoration-allowance')).toBe('28px');
    expect(sample.style.getPropertyValue('--event-decoration-grow')).toBe('1');
  });

  // Positive control: a frame is not an event decoration and keeps its feed-card sample.
  it('leaves a frame on its own sample', () => {
    const el = render({ url: 'frame', cssFrame: undefined }, 'lg');
    expect(el.querySelector('[data-testid="hat-sample"]')).toBeNull();
    expect(hatButton(el)).toBeNull();
    // The frame sample: a 120px feed card.
    expect(el.querySelector<HTMLElement>('div[style="width: 120px;"]')).not.toBeNull();
  });
});
