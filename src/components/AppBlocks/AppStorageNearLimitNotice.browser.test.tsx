import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';

import { renderWithProviders } from '../../../test/component-setup';
import { AppStorageNearLimitNoticeView } from '~/components/AppBlocks/AppStorageNearLimitNotice';
import type { MyAppStorageForApp } from '~/server/services/apps/doc-store-viewer-usage.service';

/**
 * The page host's near-limit notice. Props-only view; the one query that feeds it is the
 * container's. The ceilings are NOT the store's defaults (2 MiB / 1,000 documents), so a view
 * reading a constant instead of the figure it was given fails.
 */

const LIMITS = { userBytes: 6_000, userDocs: 25 };
const ok = (bytes: number, docs: number): MyAppStorageForApp => ({
  status: 'ok',
  limits: LIMITS,
  usage: { bytes, docs },
});

/** The view beside a sentinel: once the sentinel is in, so is whatever the view renders. */
async function renderBeside(data: MyAppStorageForApp | undefined, onDismiss = vi.fn()) {
  const { container } = await renderWithProviders(
    <>
      <div data-testid="render-barrier" />
      <AppStorageNearLimitNoticeView data={data} appName="Pinboard" onDismiss={onDismiss} />
    </>
  );
  await expect.element(page.getByTestId('render-barrier')).toBeInTheDocument();
  return container;
}

const noticeIn = (container: HTMLElement) =>
  container.querySelector('[data-testid="app-storage-near-limit"]');

describe('AppStorageNearLimitNoticeView', () => {
  test('just under 80% of both ceilings: no notice', async () => {
    // 4,799 / 6,000 bytes is 79.98%; 19 / 25 documents is 76%.
    expect(noticeIn(await renderBeside(ok(4_799, 19)))).toBeNull();
  });

  test('at 80% of the byte ceiling: the notice names the app and the share used', async () => {
    const container = await renderBeside(ok(4_800, 0));
    expect(noticeIn(container)).not.toBeNull();
    expect(noticeIn(container)?.textContent).toMatch(/used 80% of your storage in Pinboard/);
  });

  test('over 80% of the document ceiling alone: the notice shows the fuller ceiling', async () => {
    // 22 / 25 documents is 88%; the bytes are nowhere near.
    const container = await renderBeside(ok(10, 22));
    expect(noticeIn(container)?.textContent).toMatch(/used 88% of your storage/);
  });

  test('no notice while the figure is unknown or storage is off', async () => {
    expect(noticeIn(await renderBeside(undefined))).toBeNull();
    expect(noticeIn(await renderBeside({ status: 'disabled' }))).toBeNull();
  });

  test('dismiss calls back, and the notice links to the settings page in a new tab', async () => {
    const onDismiss = vi.fn();
    await renderBeside(ok(5_900, 0), onDismiss);
    const link = page.getByRole('link', { name: 'Manage app storage' });
    await expect.element(link).toHaveAttribute('href', '/user/account/security');
    await expect.element(link).toHaveAttribute('target', '_blank');
    await userEvent.click(page.getByRole('button', { name: 'Dismiss the storage notice' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
