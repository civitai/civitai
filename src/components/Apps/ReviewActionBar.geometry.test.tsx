import { Notifications, notifications } from '@mantine/notifications';
import { useRef } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { useReserveViewportBottom } from '~/components/Apps/ReviewActionBar';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { box, nextLayout, renderAtViewport } from '../../../test/geometry-setup';

/**
 * The sticky review bar's reserve against a toast from anything else on the page, in the real
 * cascade: the hook publishes how much of the viewport bottom the bar covers, and `globals.css`
 * lifts the bottom notification containers by it, so no such toast lands on the bar's buttons.
 * (That `ReviewActionBar` mounts the hook for a sticky pending bar is in its browser test.)
 */

const RESERVE = '--review-action-bar-reserve';
const DESKTOP = { width: 1124, height: 900 };

/** A sticky bottom bar shaped like the review bar, carrying the hook. */
function StickyBar() {
  const ref = useRef<HTMLDivElement>(null);
  useReserveViewportBottom(ref, true);
  return (
    <div
      ref={ref}
      data-testid="sticky-bar"
      style={{ position: 'sticky', bottom: 0, height: 120, background: 'white' }}
    >
      Approve
    </div>
  );
}

afterEach(() => {
  notifications.clean();
});

describe('the sticky review bar keeps bottom toasts off it', () => {
  test('🔴 a bottom-right toast rests above the bar; without the reserve it lands on it', async () => {
    const view = await renderAtViewport(
      <>
        <Notifications />
        {/* A long review, so the bar is stuck to the viewport bottom as on the page. */}
        <div style={{ height: 3000 }} />
        <StickyBar />
      </>,
      DESKTOP
    );
    const bar = page.getByTestId('sticky-bar');
    await expect.element(bar).toBeInTheDocument();
    notifications.show({ id: 'other', message: 'Something else happened', autoClose: false });
    await expect.element(page.getByText('Something else happened')).toBeInTheDocument();
    // Past the enter transition, so the toast is measured where it rests.
    await new Promise((resolve) => setTimeout(resolve, 600));
    await nextLayout();
    const container = () =>
      document.querySelector('.mantine-Notifications-root[data-position="bottom-right"]')!;
    const barBox = box(bar.element());
    // The bar really is at the viewport bottom, so the toast could cover it.
    expect(barBox.bottom).toBeGreaterThan(DESKTOP.height - 5);
    expect(box(container()).bottom).toBeLessThanOrEqual(barBox.top);

    // POSITIVE CONTROL: the same toast without the reserve overlaps the bar.
    const reserve = document.documentElement.style.getPropertyValue(RESERVE);
    document.documentElement.style.removeProperty(RESERVE);
    await nextLayout();
    expect(box(container()).bottom).toBeGreaterThan(barBox.top);
    document.documentElement.style.setProperty(RESERVE, reserve);

    // NEGATIVE CONTROL: once the bar is gone, nothing is reserved.
    await (await view.result).unmount();
    expect(document.documentElement.style.getPropertyValue(RESERVE)).toBe('');
  });
});
