// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DrawnMediaBoxModule from '~/components/EdgeMedia/useDrawnMediaBox';

/**
 * happy-dom has no layout, so this hands DrawnMediaHat a measured box and checks what it does with
 * it; ImageDetailCarouselHat.browser.test measures a real letterboxed picture.
 */

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  box: { width: 160, height: 80, left: 12, top: 30 } as {
    width: number;
    height: number;
    left: number;
    top: number;
  } | null,
  activeCalls: [] as boolean[],
  hostRef: { current: null } as { current: HTMLDivElement | null },
}));

vi.mock('~/components/EdgeMedia/useDrawnMediaBox', async (importOriginal) => ({
  ...(await importOriginal<typeof DrawnMediaBoxModule>()),
  useDrawnMediaBox: (active: boolean) => {
    h.activeCalls.push(active);
    return { hostRef: h.hostRef, box: active ? h.box : null };
  },
}));
vi.mock('~/components/Cosmetics/EventDecoration/WornHatPopover', () => ({
  WornHatPopover: ({
    wornOn,
    children,
  }: {
    wornOn: { entityId: number };
    children: React.ReactNode;
  }) => React.createElement('span', { 'data-worn-on': String(wornOn.entityId) }, children),
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({ EdgeMedia: () => null }));

const { DrawnMediaHat } = await import('~/components/Cosmetics/EventDecoration/DrawnMediaHat');
const { getHatLayout, getHatRoom, HAT_ALLOWANCE, HAT_PLAIN_CARD_NUDGE } = await import(
  '~/components/Cosmetics/EventDecoration/event-decoration-placement'
);
const { MEDIA_OVERLAY_ATTR } = await import('~/components/EdgeMedia/useDrawnMediaBox');

const hat = { data: { type: 'hat', event: 'birthday2026', url: 'hat.png' } } as never;

let container: HTMLDivElement;
let layer: HTMLDivElement;
let root: Root;

async function render(
  decoration: unknown,
  props: { layer?: HTMLElement | null; hidden?: boolean } = {}
) {
  await act(async () => {
    root.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(DrawnMediaHat, {
          imageId: 7,
          decoration: decoration as never,
          layer: props.layer === undefined ? layer : props.layer,
          hidden: props.hidden,
        })
      )
    );
  });
}

const hatButton = () => document.querySelector<HTMLElement>('button[data-event-decoration="hat"]');

beforeEach(() => {
  h.activeCalls = [];
  h.box = { width: 160, height: 80, left: 12, top: 30 };
  h.hostRef = { current: null };
  container = document.createElement('div');
  layer = document.createElement('div');
  document.body.append(container, layer);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  layer.remove();
});

describe('the image detail hat sits on the drawn picture', () => {
  it('drawn into the layer on the drawn box, at its width, worn on its image', async () => {
    await render(hat);
    const button = hatButton();
    expect(button).not.toBeNull();
    expect(button!.closest('[data-worn-on]')?.getAttribute('data-worn-on')).toBe('7');
    // Out of the clipping slide: the layer holds the hat, the slide only its host.
    expect(layer.contains(button)).toBe(true);
    expect(container.contains(button)).toBe(false);

    const boxEl = layer.querySelector<HTMLElement>('[data-testid="drawn-media-hat-box"]')!;
    expect(boxEl.style.left).toBe('12px');
    expect(boxEl.style.top).toBe('30px');
    expect(boxEl.style.width).toBe('160px');

    // A 160px picture wears the hat as a 160px card would: smaller than the feed-card hat.
    const full = getHatLayout('corner', undefined).width;
    const scaled = getHatLayout('corner', undefined, undefined, 0, 160).width;
    expect(scaled).toBeLessThan(full);
    expect(parseFloat(button!.style.width)).toBeCloseTo(scaled, 3);

    // The host left in the slide is how the sticker overlay beside it finds the picture.
    expect(container.querySelector(`[${MEDIA_OVERLAY_ATTR}]`)).not.toBeNull();
    expect(h.activeCalls.at(-1)).toBe(true);
  });

  it('reaches past the picture by what the slot leaves free beside it, and a feed-card reach above', async () => {
    // 12px of slot left of the box, 30px above it.
    await render(hat);
    const button = hatButton()!;
    // Rendered box offsets (about 4px and -18px here); tucked inside the picture they would be
    // about 16px and 2px.
    expect(parseFloat(button.style.left)).toBeLessThan(8);
    expect(parseFloat(button.style.top)).toBeLessThan(-10);
  });

  it('on a picture flush with the slot, reaches the feed-card room above, not past the window left', async () => {
    h.box = { width: 160, height: 80, left: 0, top: 0 };
    await render(hat);
    const layout = getHatLayout(
      'corner',
      undefined,
      { left: getHatRoom(0), top: HAT_ALLOWANCE.corner },
      HAT_PLAIN_CARD_NUDGE,
      160
    );
    expect(layout.reach.left).toBeCloseTo(2, 6);
    // Room above no longer binds: the hat sits where an unlimited one would.
    const free = getHatLayout('corner', undefined, Infinity, HAT_PLAIN_CARD_NUDGE, 160);
    expect(layout.reach.top).toBeCloseTo(free.reach.top, 6);
    expect(parseFloat(hatButton()!.style.top)).toBeCloseTo(layout.top, 3);
  });

  it('no hat until the picture is measured', async () => {
    h.box = null;
    await render(hat);
    expect(hatButton()).toBeNull();
  });

  it('no hat while the slide is moving, and none without a layer', async () => {
    await render(hat, { hidden: true });
    expect(hatButton()).toBeNull();
    await render(hat, { layer: null });
    expect(hatButton()).toBeNull();
    expect(container.querySelector('[data-testid="drawn-media-hat"]')).toBeNull();
    expect(h.activeCalls.at(-1)).toBe(false);
  });

  it('gate: nothing drawn or measured when the image carries no hat', async () => {
    await render(null);
    expect(container.querySelector('[data-testid="drawn-media-hat"]')).toBeNull();
    expect(hatButton()).toBeNull();
    expect(h.activeCalls.every((active) => active === false)).toBe(true);
  });
});
