import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { CategoryFilterButtons } from '~/components/Apps/CategoryFilterButtons';
import {
  MARKETPLACE_CATEGORIES,
  MARKETPLACE_CATEGORY_LABELS,
} from '~/server/services/blocks/marketplace-categories.constants';

/**
 * Category icon-toggle filter buttons — the control that REPLACED the category
 * <Select>. It drives the SAME `category` filter state (value / onChange), so
 * these tests assert the control's contract: one button per category + an "All"
 * clear, single-select toggle semantics, and the active state exposed via
 * `aria-pressed` (not colour alone). Each button is icon-only, so the
 * accessible NAME is the category label (aria-label + tooltip) — that's what we
 * target.
 */

const onChange = vi.fn();
beforeEach(() => onChange.mockClear());

function btn(name: string) {
  return page.getByRole('button', { name });
}

describe('CategoryFilterButtons (rendering)', () => {
  test('renders one button per category plus an "All categories" clear', async () => {
    renderWithProviders(<CategoryFilterButtons value={null} onChange={onChange} />);
    await expect.element(btn('All categories')).toBeInTheDocument();
    for (const category of MARKETPLACE_CATEGORIES) {
      await expect.element(btn(MARKETPLACE_CATEGORY_LABELS[category])).toBeInTheDocument();
    }
    // total buttons = categories + the single "All"
    expect(page.getByRole('button').elements()).toHaveLength(MARKETPLACE_CATEGORIES.length + 1);
  });
});

describe('CategoryFilterButtons (active state)', () => {
  test('value=null → "All" is pressed and no category is pressed', async () => {
    renderWithProviders(<CategoryFilterButtons value={null} onChange={onChange} />);
    await expect.element(btn('All categories')).toBeInTheDocument();
    expect(btn('All categories').element().getAttribute('aria-pressed')).toBe('true');
    expect(btn(MARKETPLACE_CATEGORY_LABELS.generation).element().getAttribute('aria-pressed')).toBe(
      'false'
    );
  });

  test('value=generation → that button is pressed and "All" is not', async () => {
    renderWithProviders(<CategoryFilterButtons value="generation" onChange={onChange} />);
    await expect.element(btn('Generation')).toBeInTheDocument();
    expect(btn('Generation').element().getAttribute('aria-pressed')).toBe('true');
    expect(btn('All categories').element().getAttribute('aria-pressed')).toBe('false');
  });
});

describe('CategoryFilterButtons (single-select toggle)', () => {
  test('clicking a category calls onChange with that category', async () => {
    renderWithProviders(<CategoryFilterButtons value={null} onChange={onChange} />);
    await expect.element(btn('Games')).toBeInTheDocument();
    await userEvent.click(btn('Games').element());
    expect(onChange).toHaveBeenCalledWith('games');
  });

  test('clicking the ALREADY-active category clears it (onChange(null))', async () => {
    renderWithProviders(<CategoryFilterButtons value="games" onChange={onChange} />);
    await expect.element(btn('Games')).toBeInTheDocument();
    await userEvent.click(btn('Games').element());
    expect(onChange).toHaveBeenCalledWith(null);
  });

  test('clicking "All" clears the filter (onChange(null))', async () => {
    renderWithProviders(<CategoryFilterButtons value="utility" onChange={onChange} />);
    await expect.element(btn('All categories')).toBeInTheDocument();
    await userEvent.click(btn('All categories').element());
    expect(onChange).toHaveBeenCalledWith(null);
  });

  test('clicking a NON-active category switches to it (single-select)', async () => {
    renderWithProviders(<CategoryFilterButtons value="games" onChange={onChange} />);
    await expect.element(btn('Utility')).toBeInTheDocument();
    await userEvent.click(btn('Utility').element());
    expect(onChange).toHaveBeenCalledWith('utility');
  });
});
