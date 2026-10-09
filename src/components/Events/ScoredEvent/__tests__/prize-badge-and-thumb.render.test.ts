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
vi.mock('@mantine/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof MantineHooks>()),
  useElementSize: () => ({ ref: { current: null }, width: measured, height: 0 }),
}));
const overlay = vi.fn();
vi.mock('~/components/Cosmetics/EventDecoration/EventDecorationOverlay', () => ({
  EventDecorationOverlay: (props: Record<string, unknown>) => {
    overlay(props);
    return React.createElement('div', { 'data-testid': 'hat' });
  },
}));

const { PrizeBadge } = await import('~/components/Events/ScoredEvent/PrizeBadge');
const { EventContentThumb } = await import('~/components/Events/ScoredEvent/EventContentThumb');

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  autoplay = true;
  measured = 0;
  overlay.mockClear();
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
    expect(src).toMatch(/width=\d+/);
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

describe('EventContentThumb hat size', () => {
  const hat = { type: 'hat', url: 'hat-url' } as React.ComponentProps<
    typeof EventContentThumb
  >['hat'];
  const thumb = () =>
    render(React.createElement(EventContentThumb, { entityType: 'Image', image: null, hat }));

  it("gives the hat the thumbnail's measured width, so it shrinks to fit", () => {
    measured = 171;
    const el = thumb();
    expect(el.querySelector('[data-testid="hat"]')).not.toBeNull();
    expect(overlay).toHaveBeenLastCalledWith(
      expect.objectContaining({ placement: 'inside', cardWidth: 171 })
    );
  });

  // A feed-sized hat for one frame would flash and overflow the small card.
  it('draws no hat until the width is measured', () => {
    measured = 0;
    expect(thumb().querySelector('[data-testid="hat"]')).toBeNull();
    expect(overlay).not.toHaveBeenCalled();
  });
});
