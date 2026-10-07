// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import {
  SpotlightDivider,
  SpotlightGlow,
  SpotlightSurface,
} from '~/components/SpotlightCard/SpotlightBorderCard';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function mount(element: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(element));
  return container.firstElementChild as HTMLElement;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

const move = (el: Element, clientX: number, clientY: number) =>
  act(() => {
    el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX, clientY }));
  });
const leave = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
  });

const placeAt = (el: Element, left: number, top: number) => {
  el.getBoundingClientRect = () => ({ left, top, x: left, y: top } as DOMRect);
};

describe('SpotlightSurface', () => {
  it('writes the cursor onto itself and, measured against each one, onto every local child', () => {
    const surface = mount(
      React.createElement(
        SpotlightSurface,
        null,
        React.createElement(SpotlightDivider),
        React.createElement(SpotlightGlow, { local: true }),
        React.createElement(SpotlightGlow)
      )
    );
    const [divider, localGlow] = surface.querySelectorAll<HTMLElement>('[data-spotlight-local]');
    placeAt(surface, 10, 100);
    placeAt(divider, 25, 160);
    placeAt(localGlow, 40, 120);

    move(surface, 30, 170);

    expect(surface.style.getPropertyValue('--spotlight-x')).toBe('20px');
    expect(surface.style.getPropertyValue('--spotlight-y')).toBe('70px');
    expect(surface.style.getPropertyValue('--spotlight-opacity')).toBe('1');
    expect(divider.style.getPropertyValue('--spotlight-x')).toBe('5px');
    expect(divider.style.getPropertyValue('--spotlight-y')).toBe('10px');
    expect(localGlow.style.getPropertyValue('--spotlight-x')).toBe('-10px');
    // Only `local` glows measure themselves; the rest read the surface's position.
    expect(surface.querySelectorAll('[data-spotlight-local]')).toHaveLength(2);

    leave(surface);
    expect(surface.style.getPropertyValue('--spotlight-opacity')).toBe('0');
  });

  // StickerShopTile's surface sits inside a Mantine Tooltip, which hands it a ref (floating-ui
  // positions from it and listens for mouseleave on it) and mouse handlers. The surface must
  // forward the ref and call those handlers as well as its own; keep every assertion here.
  it("keeps a wrapping Tooltip's ref and mouse handlers, and still lights", () => {
    const onMouseMove = vi.fn();
    const onMouseLeave = vi.fn();
    const ref = React.createRef<HTMLElement>();
    const surface = mount(
      React.createElement(SpotlightSurface, { as: 'button', ref, onMouseMove, onMouseLeave })
    );

    move(surface, 5, 5);
    expect(surface.style.getPropertyValue('--spotlight-opacity')).toBe('1');
    expect(surface.style.getPropertyValue('--spotlight-x')).toBe('5px');
    leave(surface);
    expect(surface.style.getPropertyValue('--spotlight-opacity')).toBe('0');

    expect(onMouseMove).toHaveBeenCalledTimes(1);
    expect(onMouseLeave).toHaveBeenCalledTimes(1);
    expect(ref.current).toBe(surface);
    expect(surface.tagName).toBe('BUTTON');
    expect(surface.getAttribute('type')).toBe('button');
  });
});
