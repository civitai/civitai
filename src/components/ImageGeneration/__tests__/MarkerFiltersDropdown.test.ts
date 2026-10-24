// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';

import { IsClientProvider } from '~/providers/IsClientProvider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as UseIsMobile from '~/hooks/useIsMobile';

// Justin, 2026-09-24: on mobile the generator filters must open in the bottom sheet the
// rest of the app uses, not the desktop popover anchored to a button in a 360px row.

const { useIsMobileMock } = vi.hoisted(() => ({ useIsMobileMock: vi.fn() }));

vi.mock('~/hooks/useIsMobile', async (importOriginal) => ({
  ...(await importOriginal<typeof UseIsMobile>()),
  useIsMobile: useIsMobileMock,
}));

import { DumbMarkerFiltersDropdown } from '~/components/ImageGeneration/MarkerFiltersDropdown';

/** Mantine puts `--mb-z-index` on a Drawer/Modal and on nothing else. */
const sheetIsOpen = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[style]')).some((el) =>
    el.style.getPropertyValue('--mb-z-index')
  );

// A root left mounted keeps Mantine's open-transition timer alive past the file; it then
// fires after happy-dom is torn down and fails the shard with "window is not defined".
const roots: Root[] = [];
function unmountAll() {
  act(() => roots.splice(0).forEach((root) => root.unmount()));
}

function openFilters(mobile: boolean) {
  useIsMobileMock.mockReturnValue(mobile);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      createElement(
        MantineProvider,
        null,
        createElement(
          IsClientProvider,
          null,
          createElement(DumbMarkerFiltersDropdown, { filters: {}, setFilters: vi.fn() })
        )
      )
    );
  });

  const trigger = Array.from(document.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('Filters')
  );
  expect(trigger, 'no Filters trigger rendered').toBeTruthy();
  act(() => {
    trigger!.click();
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

afterEach(() => {
  unmountAll();
  vi.useRealTimers();
});

describe('MarkerFiltersDropdown', () => {
  it('opens the bottom sheet on a touch viewport', () => {
    openFilters(true);
    expect(sheetIsOpen()).toBe(true);
  });

  it('opens the popover, not a sheet, on a wide viewport', () => {
    // The control. Without it the case above passes against a build that always opens
    // the sheet, which would put a bottom drawer on the desktop generator panel.
    openFilters(false);
    expect(sheetIsOpen()).toBe(false);
  });

  it.each([true, false])('leaves no timer pending once unmounted (mobile: %s)', (mobile) => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'],
    });
    openFilters(mobile);
    // The transition schedules its timer two animation frames after the click. The second
    // advance runs the focus trap's 0ms focus timers, queued by the commit at act() exit;
    // Mantine never clears those, but they only move focus.
    act(() => vi.advanceTimersByTime(50));
    act(() => vi.advanceTimersByTime(0));
    expect(vi.getTimerCount(), 'open transition scheduled no timer to leak').toBeGreaterThan(0);

    unmountAll();
    expect(vi.getTimerCount()).toBe(0);
  });
});
