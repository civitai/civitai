// The real cascade: a folded section is hidden by a utility class.
import '../../../../test/cascade-layer-order.css';
import '@mantine/core/styles.layer.css';
import '~/styles/globals.css';
import { beforeEach, describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { CollapsibleCard } from '~/components/Image/DetailV2/CollapsibleCard';
import { renderWithProviders } from '../../../../test/component-setup';

const KEY = 'image-detail-section:discussion';
const card = (expandFor?: number) => (
  <CollapsibleCard title="Discussion" storageKey="discussion" expandFor={expandFor}>
    <div data-testid="body">comments</div>
  </CollapsibleCard>
);

beforeEach(() => {
  // Folded away by the reader on an earlier visit.
  localStorage.setItem(KEY, 'false');
});

describe('a folded detail section', () => {
  test('stays folded without a reason to open', async () => {
    renderWithProviders(card());
    await expect.element(page.getByRole('button', { name: 'Expand Discussion' })).toBeVisible();
    expect(document.querySelector('[data-testid="body"]')?.checkVisibility() ?? false).toBe(false);
  });

  test('opens for a link into it, and stays open', async () => {
    renderWithProviders(card(777));
    await expect.element(page.getByTestId('body')).toBeVisible();
    await expect.poll(() => localStorage.getItem(KEY)).toBe('true');
  });

  test('the reader can fold it again while the same link is open', async () => {
    renderWithProviders(card(777));
    await expect.element(page.getByTestId('body')).toBeVisible();
    await page.getByRole('button', { name: 'Collapse Discussion' }).click();
    await expect.element(page.getByTestId('body')).not.toBeVisible();
  });
});
