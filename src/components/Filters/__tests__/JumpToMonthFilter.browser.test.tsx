import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as UseIsMobile from '~/hooks/useIsMobile';
import { JumpToMonthFilter } from '~/components/Filters/JumpToMonthFilter';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

// The real hook reads the layout container, which a bare render has no provider for.
vi.mock('~/hooks/useIsMobile', async (importOriginal) => ({
  ...(await importOriginal<typeof UseIsMobile>()),
  useIsMobile: () => false,
}));

describe('JumpToMonthFilter', () => {
  test('shows the chosen month and writes the month picked as YYYY-MM', async () => {
    const onChange = vi.fn();
    renderWithProviders(<JumpToMonthFilter value="2025-03" sort="Newest" onChange={onChange} />);

    const input = page.getByRole('button', { name: 'Jump to month' });
    await expect.element(input).toHaveTextContent('March 2025');
    await userEvent.click(input);
    await userEvent.click(page.getByRole('button', { name: 'Feb', exact: true }));

    expect(onChange).toHaveBeenLastCalledWith('2025-02');
  });

  test('clears the jump', async () => {
    const onChange = vi.fn();
    renderWithProviders(<JumpToMonthFilter value="2025-03" sort="Newest" onChange={onChange} />);

    await userEvent.click(page.getByRole('button', { name: 'Clear month' }));

    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  test.each([
    ['offered on Oldest', 'Oldest', true],
    ['withheld on a ranked sort', 'Most Reactions', false],
  ])('is %s', async (_, sort, enabled) => {
    renderWithProviders(<JumpToMonthFilter sort={sort} onChange={vi.fn()} />);
    const input = page.getByRole('button', { name: 'Jump to month' });
    if (enabled) await expect.element(input).toBeEnabled();
    else await expect.element(input).toBeDisabled();
  });
});
