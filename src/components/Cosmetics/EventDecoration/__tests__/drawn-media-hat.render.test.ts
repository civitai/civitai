// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DrawnMediaBoxModule from '~/components/EdgeMedia/useDrawnMediaBox';

/**
 * The image detail's hat sits on the box its picture is drawn in, drawn into a layer outside the
 * clipping carousel. happy-dom has no layout, so this hands DrawnMediaHat a measured box and checks
 * what it does with it; the browser test (ImageDetailCarouselHat.browser.test) measures a real
 * letterboxed picture but runs only locally.
 * To whoever changes this: the hat goes into the layer, not the slide, on the drawn box's top-left
 * corner as in the feed, at the box's width (so a narrow picture wears a smaller hat), reaching
 * out past the picture by as much as the slot and the header's free space allow; the host left in
 * the slide is marked as a media overlay so the sticker overlay beside it still finds the picture;
 * and nothing at all is drawn or measured when the image carries no hat, has no layer, or is moving.
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
const { getHatLayout, getHatRoom, HAT_PLAIN_CARD_NUDGE } = await import(
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

  it('reaches past the picture by what the slot and the header leave free', async () => {
    // 12px of slot left of the box, 30px above it (and 12px of free header space above that).
    await render(hat);
    const layout = getHatLayout(
      'corner',
      undefined,
      { left: getHatRoom(12), top: getHatRoom(30 + 12) },
      HAT_PLAIN_CARD_NUDGE,
      160
    );
    expect(parseFloat(hatButton()!.style.left)).toBeCloseTo(layout.left, 3);
    expect(parseFloat(hatButton()!.style.top)).toBeCloseTo(layout.top, 3);
    // On the edge, not inside it: the hat's visible extent starts outside the picture.
    expect(layout.reach.left).toBeLessThan(0);
    expect(layout.reach.top).toBeLessThan(0);
  });

  it('on a picture flush with the slot, reaches only into the header gap, not the window', async () => {
    h.box = { width: 160, height: 80, left: 0, top: 0 };
    await render(hat);
    const layout = getHatLayout(
      'corner',
      undefined,
      { left: getHatRoom(0), top: getHatRoom(12) },
      HAT_PLAIN_CARD_NUDGE,
      160
    );
    expect(layout.reach.left).toBeCloseTo(2, 6);
    expect(layout.reach.top).toBeCloseTo(-10, 6);
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
