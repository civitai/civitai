// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDragClickGuard } from './UserMenuParts';

/**
 * dnd-kit skips `onDragEnd` and `onDragCancel` when the browser cancels the pointer before the drag
 * has rendered, which on a phone a fast flick does. The guard must not stay on after that: it
 * eats every click on the page, and the menu can no longer be closed.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let guard: ReturnType<typeof useDragClickGuard>;
let root: Root;
let target: HTMLButtonElement;
let reached: number;

function Harness() {
  guard = useDragClickGuard();
  return null;
}

const pointerdown = (isPrimary: boolean) =>
  target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary }));

/** Whether a click on the row is let through to its handlers. */
function click() {
  reached = 0;
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return { delivered: reached === 1, defaultPrevented: event.defaultPrevented };
}

beforeEach(() => {
  vi.useFakeTimers();
  target = document.createElement('button');
  target.addEventListener('click', () => reached++);
  document.body.append(target);
  root = createRoot(document.createElement('div'));
  act(() => root.render(createElement(Harness)));
});

afterEach(() => {
  act(() => root.unmount());
  target.remove();
  vi.useRealTimers();
});

describe('useDragClickGuard', () => {
  it('swallows the click a drop produces, then lets clicks through again', () => {
    pointerdown(true);
    guard.onDragStart();
    // dnd-kit ends the drag before the browser dispatches the drop's click.
    guard.onDragSettled();
    expect(click()).toEqual({ delivered: false, defaultPrevented: true });

    vi.runAllTimers();
    expect(click().delivered).toBe(true);
  });

  it('lets clicks through after a drag whose end and cancel never arrived', () => {
    pointerdown(true);
    guard.onDragStart();

    // The next tap begins with its own pointerdown.
    pointerdown(true);
    expect(click()).toEqual({ delivered: true, defaultPrevented: false });
  });

  it('keeps swallowing while a second finger lands mid-drag', () => {
    pointerdown(true);
    guard.onDragStart();

    pointerdown(false);
    expect(click().delivered).toBe(false);
  });
});
