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
  vi.restoreAllMocks();
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

  it.each([true, false])('leaves no timer pending once unmounted (mobile: %s)', async (mobile) => {
    const pending = new Map<number, number>(); // id -> delay
    const realSetTimeout = window.setTimeout.bind(window);
    const realClearTimeout = window.clearTimeout.bind(window);
    vi.spyOn(window, 'setTimeout').mockImplementation(((
      fn: (...args: unknown[]) => void,
      ms = 0,
      ...args: unknown[]
    ) => {
      const id: number = realSetTimeout(() => {
        pending.delete(id);
        fn(...args);
      }, ms);
      pending.set(id, ms);
      return id;
    }) as typeof window.setTimeout);
    vi.spyOn(window, 'clearTimeout').mockImplementation((id) => {
      pending.delete(id as number);
      realClearTimeout(id);
    });
    const transitionPending = () => [...pending.values()].some((ms) => ms >= 100);

    openFilters(mobile);
    // The transition schedules its timer two animation frames after the click.
    for (let i = 0; i < 100 && !transitionPending(); i++)
      await act(() => new Promise((resolve) => realSetTimeout(resolve, 5)));
    expect(transitionPending(), 'open transition scheduled no timer to leak').toBe(true);

    unmountAll();
    expect(pending.size).toBe(0);
  });
});
