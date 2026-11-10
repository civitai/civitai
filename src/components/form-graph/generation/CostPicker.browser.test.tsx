import type { WorkflowCost } from '@civitai/orchestration-client';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import { CostPicker } from '~/components/form-graph/generation/CostPicker';
import type * as MobileGenerator from '~/hooks/useMobileGenerator';
import { useTipStore } from '~/store/tip.store';

// The layout comes from the flag and media queries, which the test browser can't set.
let layout: 'mobile' | 'desktop' = 'mobile';
vi.mock('~/hooks/useMobileGenerator', async (importOriginal) => ({
  ...(await importOriginal<typeof MobileGenerator>()),
  useMobileGenerator: () => layout === 'mobile',
  useGeneratorLayout: () => layout,
}));

const setBuzzType = vi.fn();
vi.mock('~/components/Generation/footer-parts', () => ({
  useSelectedBuzzType: () => ({
    availableTypes: ['yellow', 'green'],
    selectedType: 'yellow',
    setBuzzType,
  }),
}));
let buzzLoading = false;
vi.mock('~/components/Buzz/useBuzz', () => ({
  useQueryBuzz: () => ({
    isLoading: buzzLoading,
    data: {
      accounts: [
        { type: 'yellow', balance: 20000 },
        { type: 'green', balance: 5 },
      ],
    },
  }),
}));
// The breakdown table is GenerationCostPopover's own; here only its place in the picker matters.
vi.mock('~/components/ImageGeneration/GenerationForm/GenerationCostPopover', () => ({
  GenerationCostPopoverDetail: () => <p>Breakdown table</p>,
}));

describe('CostPicker', () => {
  const props = {
    cost: 12345,
    workflowCost: { base: 10000, total: 12345 } as WorkflowCost,
    loading: false,
    error: false,
    unavailable: false,
    onRetry: vi.fn(),
    showCreatorTip: true,
    showCivitaiTip: true,
  };

  beforeEach(() => {
    layout = 'mobile';
    localStorage.setItem('buzz-type-selector-seen', '1');
    useTipStore.setState({ creatorTip: 0.25, civitaiTip: 0 });
    setBuzzType.mockClear();
  });

  test('the Buzz button shows the total and opens the cost sheet', async () => {
    renderWithProviders(<CostPicker {...props} />);
    const button = page.getByRole('button', { name: 'Cost and Buzz type' });
    await expect.element(button).toHaveTextContent('12,345');
    await button.click();

    const sheet = page.getByRole('dialog', { name: 'Cost for this run' });
    await expect.element(sheet.getByText('Balance after this run: 7,655')).toBeInTheDocument();
    // The breakdown is folded until asked for.
    await expect.element(sheet.getByText('Breakdown table')).not.toBeInTheDocument();
    await sheet.getByRole('button', { name: 'How this is calculated' }).click();
    await expect.element(sheet.getByText('Breakdown table')).toBeInTheDocument();
  });

  test('the tip steppers set the tips in steps of 5%', async () => {
    renderWithProviders(<CostPicker {...props} />);
    await page.getByRole('button', { name: 'Cost and Buzz type' }).click();
    await page.getByRole('button', { name: 'Raise the creator tip' }).click();
    expect(useTipStore.getState().creatorTip).toBeCloseTo(0.3);
    await expect
      .element(page.getByRole('button', { name: 'Lower the civitai tip' }))
      .toBeDisabled();
  });

  test('paying with another Buzz type selects it', async () => {
    renderWithProviders(<CostPicker {...props} />);
    await page.getByRole('button', { name: 'Cost and Buzz type' }).click();
    await expect
      .element(page.getByRole('radio', { name: /yellow Buzz/i }))
      .toHaveAttribute('aria-checked', 'true');
    await page.getByRole('radio', { name: /green Buzz/i }).click();
    expect(setBuzzType).toHaveBeenCalledWith('green');
  });

  test('a balance short of the total says how much more is needed', async () => {
    renderWithProviders(<CostPicker {...props} cost={20001} />);
    await page.getByRole('button', { name: 'Cost and Buzz type' }).click();
    await expect.element(page.getByText('Not enough: 1 more needed')).toBeInTheDocument();
  });

  test('while the balance loads, the sheet does not claim there is not enough', async () => {
    buzzLoading = true;
    try {
      renderWithProviders(<CostPicker {...props} cost={20001} />);
      await page.getByRole('button', { name: 'Cost and Buzz type' }).click();
      await expect
        .element(page.getByRole('dialog', { name: 'Cost for this run' }))
        .toBeInTheDocument();
      await expect.element(page.getByText(/Balance after|Not enough/)).not.toBeInTheDocument();
    } finally {
      buzzLoading = false;
    }
  });

  test('with no estimate possible, the cost is a dash and no balance line shows', async () => {
    renderWithProviders(<CostPicker {...props} cost={0} unavailable />);
    const button = page.getByRole('button', { name: 'Cost and Buzz type' });
    await expect.element(button).toHaveTextContent('–');
    await button.click();
    await expect.element(page.getByText(/Balance after|Not enough/)).not.toBeInTheDocument();
  });

  test('a failed estimate offers a retry instead of a cost', async () => {
    const onRetry = vi.fn();
    renderWithProviders(<CostPicker {...props} error onRetry={onRetry} />);
    await page.getByRole('button', { name: 'Cost estimate failed. Retry' }).click();
    expect(onRetry).toHaveBeenCalled();
  });

  test('on desktop the same picker opens as a popover beside the button', async () => {
    layout = 'desktop';
    renderWithProviders(<CostPicker {...props} />);
    await page.getByRole('button', { name: 'Cost and Buzz type' }).click();
    await expect.element(page.getByText('Balance after this run: 7,655')).toBeInTheDocument();
    await expect.element(page.getByRole('radiogroup', { name: 'Pay with' })).toBeInTheDocument();
    await expect
      .element(page.getByRole('button', { name: 'Raise the creator tip' }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole('button', { name: 'How this is calculated' }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole('dialog', { name: 'Cost for this run' }))
      .not.toBeInTheDocument();
  });

  test('on desktop a second click on the button closes the popover', async () => {
    layout = 'desktop';
    renderWithProviders(<CostPicker {...props} />);
    const button = page.getByRole('button', { name: 'Cost and Buzz type' });
    await button.click();
    const payWith = page.getByRole('radiogroup', { name: 'Pay with' });
    await expect.element(payWith).toBeInTheDocument();
    await button.click();
    await expect.element(payWith).not.toBeInTheDocument();
  });

  test('the button glows until it is first opened', async () => {
    localStorage.removeItem('buzz-type-selector-seen');
    renderWithProviders(<CostPicker {...props} />);
    const button = page.getByRole('button', { name: 'Cost and Buzz type' });
    await expect.element(button).toHaveClass('animate-buzz-glow');
    await button.click();
    await expect.element(button).not.toHaveClass('animate-buzz-glow');
    expect(localStorage.getItem('buzz-type-selector-seen')).toBe('1');
  });
});
