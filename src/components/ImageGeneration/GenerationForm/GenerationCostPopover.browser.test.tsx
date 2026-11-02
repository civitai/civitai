import type { TransactionInfo, WorkflowCost } from '@civitai/orchestration-client';
import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import { GenerationCostPopover } from '~/components/ImageGeneration/GenerationForm/GenerationCostPopover';

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
});
