import type { TransactionInfo, WorkflowCost } from '@civitai/orchestration-client';
import { ModalsProvider } from '@mantine/modals';
import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import { GenerationCostPopover } from '~/components/ImageGeneration/GenerationForm/GenerationCostPopover';
import { mobileMenuSheetZIndex } from '~/shared/constants/app-layout.constants';

// Both read feature flags, which the test providers don't supply.
vi.mock('~/components/Buzz/useAvailableBuzz', () => ({
  useAvailableBuzz: () => ['blue', 'yellow'],
}));
vi.mock('~/hooks/useMobileGenerator', () => ({ useGeneratorLayout: () => 'desktop' }));

const cost: WorkflowCost = { base: 40, total: 50, factors: {}, tips: { creators: 10, civitai: 0 } };
const transactions = [
  { type: 'debit', amount: 30, accountType: 'yellow' },
  { type: 'debit', amount: 20, accountType: 'blue' },
  { type: 'credit', amount: 20, accountType: 'blue' },
] as TransactionInfo[];

describe('GenerationCostPopover', () => {
  test("a run's cost badge also shows what paid for it, refunds included", async () => {
    renderWithProviders(
      <GenerationCostPopover
        workflowCost={cost}
        transactions={transactions}
        readOnly
        variant="badge"
      />
    );
    await page.getByRole('button', { name: /50/ }).click();

    await expect.element(page.getByText('Paid With')).toBeVisible();
    await expect.element(page.getByText('Yellow Buzz', { exact: true })).toBeVisible();
    await expect.element(page.getByText('Blue Buzz', { exact: true })).toBeVisible();
    await expect.element(page.getByText('Blue Buzz (refunded)')).toBeVisible();
  });

  test('the cost explanation opens above the phone sheets', async () => {
    renderWithProviders(
      <ModalsProvider>
        <GenerationCostPopover workflowCost={cost} readOnly variant="badge" />
      </ModalsProvider>
    );
    await page.getByRole('button', { name: /50/ }).click();
    await page.getByRole('button', { name: 'How the cost is calculated' }).click();

    const modal = page.getByRole('dialog', { name: 'Generation Cost Breakdown' });
    await expect.element(modal).toBeVisible();
    // Mantine sets the modal's layer as a custom property on its root (`--mb-z-index`).
    const root = modal.element().closest<HTMLElement>('[style*="--mb-z-index"]');
    expect(root).not.toBeNull();
    expect(Number(root!.style.getPropertyValue('--mb-z-index'))).toBeGreaterThan(
      mobileMenuSheetZIndex
    );
  });
});
