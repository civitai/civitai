import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';

import { renderWithProviders } from '../../../test/component-setup';
import { AppStorageCardView } from '~/components/Account/AppStorageCard';
import type { MyAppStorage } from '~/server/services/apps/doc-store-viewer-usage.service';

/**
 * The account-settings "App storage" card. Props-only view; the container's tRPC wiring is out
 * of frame. The ceilings are NOT the store's defaults (2 MiB / 1,000 documents).
 */

const LIMITS = { userBytes: 4_000, userDocs: 30 };
const ok = (apps: Extract<MyAppStorage, { status: 'ok' }>['apps']): MyAppStorage => ({
  status: 'ok',
  limits: LIMITS,
  apps,
});

describe('AppStorageCardView', () => {
  test("shows each app's usage against the per-viewer ceilings it was given, and flags the near-full one", async () => {
    await renderWithProviders(
      <AppStorageCardView
        onEmpty={vi.fn()}
        data={ok([
          {
            appBlockId: 'apb_1',
            name: 'Alpha',
            slug: 'alpha',
            usage: { bytes: 1_000, docs: 3 },
          },
          { appBlockId: 'apb_2', name: 'Beta', slug: 'beta', usage: { bytes: 10, docs: 27 } },
          { appBlockId: 'apb_3', name: null, slug: null, usage: { bytes: 5, docs: 1 } },
        ])}
      />
    );
    const alpha = page.getByTestId('app-storage-row-apb_1');
    await expect.element(alpha).toHaveTextContent('Alpha');
    await expect.element(alpha).toHaveTextContent('3 of 30 items');
    await expect.element(alpha).not.toHaveTextContent('Near limit');
    await expect
      .element(page.getByTestId('app-storage-bar-apb_1'))
      .toHaveAttribute('aria-valuenow', '25');
    // 27 / 30 documents is 90%: the fuller ceiling drives the bar and the badge.
    const beta = page.getByTestId('app-storage-row-apb_2');
    await expect.element(beta).toHaveTextContent('Near limit');
    await expect
      .element(page.getByTestId('app-storage-bar-apb_2'))
      .toHaveAttribute('aria-valuenow', '90');
    await expect
      .element(page.getByTestId('app-storage-row-apb_3'))
      .toHaveTextContent(/removed app/);
  });

  test('Empty hands the row to the caller (which confirms before deleting)', async () => {
    const onEmpty = vi.fn();
    const app = { appBlockId: 'apb_9', name: 'Gamma', slug: 'gamma', usage: { bytes: 7, docs: 2 } };
    await renderWithProviders(<AppStorageCardView onEmpty={onEmpty} data={ok([app])} />);
    await userEvent.click(
      page.getByTestId('app-storage-row-apb_9').getByRole('button', { name: 'Empty' })
    );
    expect(onEmpty).toHaveBeenCalledWith(app);
  });

  test('renders nothing with no data, or with storage off', async () => {
    const { container } = await renderWithProviders(
      <>
        <div data-testid="render-barrier" />
        <AppStorageCardView onEmpty={vi.fn()} data={ok([])} />
        <AppStorageCardView onEmpty={vi.fn()} data={{ status: 'disabled' }} />
      </>
    );
    await expect.element(page.getByTestId('render-barrier')).toBeInTheDocument();
    expect(container.querySelector('[data-testid="app-storage-card"]')).toBeNull();
  });
});
