import { Notifications, notifications } from '@mantine/notifications';
import { afterEach, describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { dialogStore, useDialogStore } from '~/components/Dialog/dialogStore';
import { RemixTrayView } from '~/components/Image/Remix/RemixTray';
import type { RemixRun } from '~/components/Image/Remix/useRemixRuns';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { box, nextLayout, renderAtViewport } from '../../../../test/geometry-setup';

const run = (n: number): RemixRun => ({
  runId: `r${n}`,
  workflowId: `wf-${n}`,
  slug: 'anime-it',
  appName: `Run ${n}`,
  runtime: true,
  status: 'ready',
});

const runs = [1, 2, 3, 4, 5].map(run);

afterEach(() => {
  notifications.clean();
  useDialogStore.setState({ dialogs: [] });
});

const zIndexOfTray = () =>
  getComputedStyle(document.querySelector('[data-testid="remix-tray"]')!).zIndex;

describe('RemixTray over a toast, on a phone', () => {
  test('an open tray takes the tap on its lowest row, not the toast beneath it', async () => {
    await renderAtViewport(
      <>
        <Notifications />
        <RemixTrayView runs={runs} inProgress={0} ready={runs.length} onDismiss={() => undefined} />
      </>
    );
    // A promo toast that stays up, as on the demo, under two more: the stack reaches the rows.
    for (const id of ['promo', 'second', 'third'])
      notifications.show({
        id,
        title: id === 'promo' ? 'Hat Turf is live' : `Toast ${id}`,
        message: 'Claim a hat before the round ends. '.repeat(4),
        autoClose: false,
      });
    await page.getByRole('button', { name: /^Remix runs:/ }).click();
    // Past the toasts' enter transition, so they are measured where they rest.
    await new Promise((resolve) => setTimeout(resolve, 600));
    await nextLayout();

    const lowestRow = page.getByRole('list', { name: 'Remix runs' }).getByRole('listitem').last();
    const rowBox = box(lowestRow.element());
    const toasts = document.querySelector(
      '.mantine-Notifications-root[data-position="bottom-right"]'
    );
    // POSITIVE CONTROL: the toasts really cover the row, so the hit test below could fail.
    expect(toasts).not.toBeNull();
    const toastBox = box(toasts!);
    expect(toastBox.top).toBeLessThan(rowBox.top + rowBox.height / 2);
    expect(toastBox.top + toastBox.height).toBeGreaterThan(rowBox.top + rowBox.height / 2);
    expect(toastBox.left).toBeLessThan(rowBox.left + rowBox.width / 2);

    const hit = document.elementFromPoint(
      rowBox.left + rowBox.width / 2,
      rowBox.top + rowBox.height / 2
    );
    expect(hit?.closest('[data-testid="remix-tray"]')).not.toBeNull();
  });

  test('drops under a modal while one is open, and floats over the image page as a modal', async () => {
    await renderAtViewport(
      <RemixTrayView runs={runs} inProgress={0} ready={runs.length} onDismiss={() => undefined} />
    );
    const floating = zIndexOfTray();
    // Dialogs stack from 300 (DialogProvider).
    expect(Number(floating)).toBeGreaterThan(300);

    dialogStore.trigger({ id: 'image', type: 'routed-dialog', component: () => null });
    await nextLayout();
    expect(zIndexOfTray()).toBe(floating);

    dialogStore.trigger({ id: 'remix', component: () => null });
    await nextLayout();
    expect(Number(zIndexOfTray())).toBeLessThan(300);
  });
});
