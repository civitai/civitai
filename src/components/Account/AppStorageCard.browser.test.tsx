import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';

import { renderWithProviders } from '../../../test/component-setup';
import { AppStorageCardView, EmptyConfirmBody } from '~/components/Account/AppStorageCard';
import type {
  MyAppStorage,
  MyAppStorageApp,
} from '~/server/services/apps/doc-store-viewer-usage.service';

/**
 * The account-settings "App storage" card. Props-only view; the container's tRPC wiring is out
 * of frame. The ceilings are NOT the store's defaults (2 MiB / 1,000 documents).
 */

const LIMITS = { userBytes: 4_000, userDocs: 30 };
const NONE = { bytes: 0, docs: 0 };
/** A row whose whole figure is private data (what every Empty deletes), unless told otherwise. */
const row = (
  appBlockId: string,
  name: string | null,
  usage: { bytes: number; docs: number },
  parts: Partial<MyAppStorageApp['holdings']> = { private: usage }
): MyAppStorageApp => ({
  appBlockId,
  name,
  slug: name?.toLowerCase() ?? null,
  usage,
  holdings: { private: NONE, shared: NONE, hidden: NONE, counters: NONE, ...parts },
});
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
          row('apb_1', 'Alpha', { bytes: 1_000, docs: 3 }),
          row('apb_2', 'Beta', { bytes: 10, docs: 27 }),
          row('apb_3', null, { bytes: 5, docs: 1 }),
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
    const app = row('apb_9', 'Gamma', { bytes: 7, docs: 2 });
    await renderWithProviders(<AppStorageCardView onEmpty={onEmpty} data={ok([app])} />);
    await userEvent.click(
      page.getByTestId('app-storage-row-apb_9').getByRole('button', { name: 'Empty' })
    );
    expect(onEmpty).toHaveBeenCalledWith(app);
  });

  test('a user holding only a counter they started is told it stays, and cannot Empty', async () => {
    const onEmpty = vi.fn();
    await renderWithProviders(
      <AppStorageCardView
        onEmpty={onEmpty}
        data={ok([
          row('apb_c', 'Counter', { bytes: 2, docs: 1 }, { counters: { bytes: 2, docs: 1 } }),
        ])}
      />
    );
    const r = page.getByTestId('app-storage-row-apb_c');
    await expect
      .element(r.getByTestId('app-storage-kept-apb_c'))
      .toHaveTextContent('1 item stays: counters you started.');
    await expect.element(r.getByRole('button', { name: 'Empty' })).toBeDisabled();
  });

  test('a user holding only posts moderation hid is told they stay, and cannot Empty', async () => {
    await renderWithProviders(
      <AppStorageCardView
        onEmpty={vi.fn()}
        data={ok([
          row('apb_h', 'Hidden', { bytes: 90, docs: 2 }, { hidden: { bytes: 90, docs: 2 } }),
        ])}
      />
    );
    const r = page.getByTestId('app-storage-row-apb_h');
    await expect
      .element(r.getByTestId('app-storage-kept-apb_h'))
      .toHaveTextContent('2 items stay: posts hidden by moderation.');
    await expect.element(r.getByRole('button', { name: 'Empty' })).toBeDisabled();
  });

  test('with something clearable Empty stays enabled and the part that stays is still named; with nothing kept no note shows', async () => {
    await renderWithProviders(
      <AppStorageCardView
        onEmpty={vi.fn()}
        data={ok([
          row(
            'apb_m',
            'Mixed',
            { bytes: 300, docs: 5 },
            {
              shared: { bytes: 100, docs: 1 },
              hidden: { bytes: 100, docs: 1 },
              counters: { bytes: 100, docs: 3 },
            }
          ),
          row('apb_p', 'Plain', { bytes: 40, docs: 1 }),
        ])}
      />
    );
    const mixed = page.getByTestId('app-storage-row-apb_m');
    await expect
      .element(mixed.getByTestId('app-storage-kept-apb_m'))
      .toHaveTextContent('4 items stay: counters you started and posts hidden by moderation.');
    await expect.element(mixed.getByRole('button', { name: 'Empty' })).toBeEnabled();
    const plain = page.getByTestId('app-storage-row-apb_p');
    await expect.element(plain.getByRole('button', { name: 'Empty' })).toBeEnabled();
    expect(
      document.querySelector('[data-testid="app-storage-kept-apb_p"]'),
      'no note for a row Empty clears completely'
    ).toBeNull();
  });

  test('the confirmation names what stays, and offers the shared option only when there are posts to delete', async () => {
    await renderWithProviders(
      <>
        <div data-testid="confirm-kept">
          <EmptyConfirmBody
            app={row(
              'apb_k',
              'Keeper',
              { bytes: 50, docs: 3 },
              { private: { bytes: 20, docs: 1 }, counters: { bytes: 30, docs: 2 } }
            )}
            onIncludeSharedChange={vi.fn()}
          />
        </div>
        <div data-testid="confirm-shared">
          <EmptyConfirmBody
            app={row('apb_s', 'Sharer', { bytes: 9, docs: 1 }, { shared: { bytes: 9, docs: 1 } })}
            onIncludeSharedChange={vi.fn()}
          />
        </div>
      </>
    );
    const kept = page.getByTestId('confirm-kept');
    await expect.element(kept).toHaveTextContent('2 items stay: counters you started.');
    await expect.element(kept.getByRole('checkbox')).not.toBeInTheDocument();
    const shared = page.getByTestId('confirm-shared');
    await expect.element(shared).toHaveTextContent('You have no private data in Sharer.');
    await expect.element(shared.getByRole('checkbox')).toBeInTheDocument();
    await expect.element(shared).not.toHaveTextContent(/\d+ items? stays?:/);
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
