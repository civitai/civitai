// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { SpotlightDivider, SpotlightSurface } from '~/components/SpotlightCard/SpotlightBorderCard';

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

describe('SpotlightSurface', () => {
  it('writes the cursor onto itself and onto every local child, without a render', () => {
    const surface = mount(
      React.createElement(SpotlightSurface, null, React.createElement(SpotlightDivider))
    );
    const divider = surface.querySelector<HTMLElement>('[data-spotlight-local]')!;

    move(surface, 30, 12);

    expect(surface.style.getPropertyValue('--spotlight-x')).toBe('30px');
    expect(surface.style.getPropertyValue('--spotlight-y')).toBe('12px');
    expect(surface.style.getPropertyValue('--spotlight-opacity')).toBe('1');
    expect(divider.style.getPropertyValue('--spotlight-x')).toBe('30px');

    leave(surface);
    expect(surface.style.getPropertyValue('--spotlight-opacity')).toBe('0');
  });

  // A Mantine Tooltip wraps StickerShopTile's surface and injects its own mouse handlers and
  // ref. If the surface REPLACED them instead of composing, the tooltip would never close
  // and could not position itself. Keep both halves of this test.
  it("keeps a wrapping Tooltip's mouse handlers and ref working", () => {
    const onMouseMove = vi.fn();
    const onMouseLeave = vi.fn();
    const ref = React.createRef<HTMLElement>();
    const surface = mount(
      React.createElement(SpotlightSurface, { as: 'button', ref, onMouseMove, onMouseLeave })
    );

    move(surface, 5, 5);
    leave(surface);

    expect(onMouseMove).toHaveBeenCalledTimes(1);
    expect(onMouseLeave).toHaveBeenCalledTimes(1);
    expect(ref.current).toBe(surface);
    expect(surface.tagName).toBe('BUTTON');
    expect(surface.getAttribute('type')).toBe('button');
  });
});
