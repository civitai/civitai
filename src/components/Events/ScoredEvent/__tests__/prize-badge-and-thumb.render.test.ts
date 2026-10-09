// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import type * as MantineHooks from '@mantine/hooks';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The prize badge's URL (only an optimized, sized variant keeps the animation and transparency;
 * autoplay off gets the still file) and the "Your hats" thumbnail passing its own width to the hat.
 */

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let autoplay = true;
vi.mock('~/providers/BrowserSettingsProvider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAutoplayGifs: () => autoplay,
}));
let measured = 0;
// A callback ref, so a test sees which element the size is measured on.
const measuredRef = vi.fn();
vi.mock('@mantine/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof MantineHooks>()),
  useElementSize: () => ({ ref: measuredRef, width: measured, height: 0 }),
}));
const overlay = vi.fn();
vi.mock('~/components/Cosmetics/EventDecoration/EventDecorationOverlay', () => ({
  EventDecorationOverlay: (props: Record<string, unknown>) => {
    overlay(props);
    return React.createElement('button', { 'data-testid': 'hat' });
  },
}));

const { PrizeBadge } = await import('~/components/Events/ScoredEvent/PrizeBadge');
const { getEventDecorationClearLeftCss, HAT_PLAIN_CARD_NUDGE } = await import(
  '~/components/Cosmetics/EventDecoration/event-decoration-placement'
);
const { EventContentThumb } = await import('~/components/Events/ScoredEvent/EventContentThumb');

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  autoplay = true;
  measured = 0;
  overlay.mockClear();
  measuredRef.mockClear();
});

function render(element: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(React.createElement(MantineProvider, null, element)));
  return host;
}

const badge = {
  animated: 'd0aedf96-8bb4-4837-9e22-f13662391e98',
  static: 'aa5ee01e-dfee-458a-9431-16c5e8656754',
};

describe('PrizeBadge', () => {
  it('asks for an optimized, sized variant of the animated file', () => {
    const src = render(React.createElement(PrizeBadge, { badge })).querySelector('img')!.src;
    expect(src).toContain(badge.animated);
    expect(src).toContain('optimized=true');
    // 160px requested (twice the displayed size), snapped up to the CDN's 320 rung.
    expect(src).toContain('width=320');
    expect(src).not.toContain('anim=false');
  });

  it('serves the still file to a viewer with autoplay off', () => {
    autoplay = false;
    const src = render(React.createElement(PrizeBadge, { badge })).querySelector('img')!.src;
    expect(src).toContain(badge.static);
    expect(src).not.toContain(badge.animated);
    expect(src).toContain('optimized=true');
  });
});

describe('EventContentThumb wears its hat as a feed card does', () => {
  const hat = { type: 'hat', url: 'hat-url' } as React.ComponentProps<
    typeof EventContentThumb
  >['hat'];
  const thumb = (props: Record<string, unknown> = {}) =>
    render(
      React.createElement(EventContentThumb, { entityType: 'Image', image: null, hat, ...props })
    );
  const wrapperOf = (el: HTMLElement) =>
    [...el.children].find((c) => c.tagName === 'DIV') as HTMLElement;

  it("draws the hat on the feed's corner, outside the clipped card, at the card's width", () => {
    measured = 171;
    const wrapper = wrapperOf(thumb());
    // The feed's own wrapper: it carries the hover-grow hook and holds the hat beside the card.
    expect(wrapper.dataset.eventDecoration).toBe('hat');
    const [card, worn] = [...wrapper.children] as HTMLElement[];
    expect(card.className).toContain('overflow-hidden');
    expect(worn.dataset.testid).toBe('hat');
    expect(card.contains(worn)).toBe(false);
    // The width is the card's own: the measuring ref is on it.
    expect(measuredRef).toHaveBeenCalledWith(card);
    expect(overlay).toHaveBeenLastCalledWith({ decoration: hat, framed: false, cardWidth: 171 });
    expect(wrapper.style.getPropertyValue('--event-decoration-clear-left')).toBe(
      getEventDecorationClearLeftCss(hat!, undefined, HAT_PLAIN_CARD_NUDGE, 171)
    );
  });

  it('lets the hat reach only as far as the room around the card', () => {
    measured = 171;
    expect(wrapperOf(thumb()).style.getPropertyValue('--event-decoration-allowance')).toBe('4px');
    act(() => root?.unmount());
    host?.remove();
    expect(
      wrapperOf(thumb({ allowance: 12 })).style.getPropertyValue('--event-decoration-allowance')
    ).toBe('12px');
  });

  // A feed-sized hat for one frame would flash; mounting it late would shift the layout.
  it('hides the hat until the card is measured, without changing what is drawn', () => {
    measured = 0;
    const wrapper = wrapperOf(thumb());
    expect(wrapper.querySelector('[data-testid="hat"]')).not.toBeNull();
    expect(wrapper.className).toContain('[&>button]:invisible');
    act(() => root?.unmount());
    host?.remove();
    measured = 171;
    expect(wrapperOf(thumb()).className).not.toContain('invisible');
  });

  it('is a plain card with no hat', () => {
    measured = 171;
    const card = wrapperOf(thumb({ hat: undefined }));
    expect(card.dataset.eventDecoration).toBeUndefined();
    expect(card.className).toContain('overflow-hidden');
    expect(overlay).not.toHaveBeenCalled();
  });
});
