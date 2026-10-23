import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';

import { renderWithProviders } from '../../../test/component-setup';
import { AppDocStoreUsageCardView } from '~/components/Apps/AppDocStoreUsageCard';
import type { MyDocStoreUsage } from '~/server/services/apps/doc-store-owner-usage.service';

/**
 * The owner's document-storage card on `/apps/build`. Props-only view; the container's tRPC
 * wiring is out of frame.
 *
 * The limits here are deliberately NOT the store's defaults (50 MiB / 1M documents), so a
 * view that rendered the constant instead of the figure it was given fails.
 */

const LIMITS = { appBytes: 10_485_760, appDocs: 20_000 };

function ok(apps: Extract<MyDocStoreUsage, { status: 'ok' }>['apps']): MyDocStoreUsage {
  return { status: 'ok', limits: LIMITS, apps };
}

describe('AppDocStoreUsageCardView', () => {
  test('shows each app’s usage against the limits it was given', async () => {
    await renderWithProviders(
      <AppDocStoreUsageCardView
        data={ok([
          { appBlockId: 'apb_1', name: 'Alpha', usage: { bytes: 3_145_728, docs: 4_321 } },
          { appBlockId: 'apb_2', name: 'Beta', usage: { bytes: 0, docs: 0 } },
        ])}
      />
    );
    const alpha = page.getByTestId('apps-docstore-usage-apb_1');
    await expect.element(alpha).toHaveTextContent('Alpha');
    await expect.element(alpha).toHaveTextContent('3 MB of 10 MB');
    await expect.element(alpha).toHaveTextContent('4,321 of 20,000 documents');
    await expect
      .element(page.getByTestId('apps-docstore-usage-bytes-apb_1'))
      .toHaveAttribute('aria-valuenow', '30');
    const beta = page.getByTestId('apps-docstore-usage-apb_2');
    await expect.element(beta).toHaveTextContent('0 of 20,000 documents');
  });

  test('an app whose usage could not be read says so, rather than showing zero', async () => {
    await renderWithProviders(
      <AppDocStoreUsageCardView data={ok([{ appBlockId: 'apb_3', name: 'Gamma', usage: null }])} />
    );
    const gamma = page.getByTestId('apps-docstore-usage-apb_3');
    await expect.element(gamma).toHaveTextContent(/usage unavailable/i);
    await expect.element(gamma).not.toHaveTextContent(/0 of/);
  });

  test('renders nothing when the store is disabled', async () => {
    const { container } = await renderWithProviders(
      <AppDocStoreUsageCardView data={{ status: 'disabled' }} />
    );
    expect(container.querySelector('[data-testid="apps-docstore-usage"]')).toBeNull();
    expect(container.textContent).not.toMatch(/0 of/);
  });

  test('renders nothing when the owner has no on-platform apps', async () => {
    const { container } = await renderWithProviders(<AppDocStoreUsageCardView data={ok([])} />);
    expect(container.querySelector('[data-testid="apps-docstore-usage"]')).toBeNull();
  });
});
