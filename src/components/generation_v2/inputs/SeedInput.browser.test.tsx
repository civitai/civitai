import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { SeedInput } from '~/components/generation_v2/inputs/SeedInput';
import { MAX_SEED, MAX_RANDOM_SEED } from '~/shared/constants/generation.constants';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

// First component test (Vitest browser mode). SeedInput is a high-churn
// generation-form leaf with real, lockable behavior and pure value/onChange
// props (no tRPC/router) — it anchors the scaffold while exercising Mantine
// (SegmentedControl + NumberInput), which is the browser-fidelity reason we
// chose browser mode over jsdom. The `random` (undefined) vs `custom` (number)
// contract is the invariant the rest of the form relies on.
//
// Queries go through the global `page` (whole-document); `cleanup()` after each
// test (component-setup.tsx) keeps the document free of prior renders.
describe('SeedInput', () => {
  test('value=undefined renders as Random with an empty number field', async () => {
    renderWithProviders(<SeedInput value={undefined} onChange={vi.fn()} />);

    await expect.element(page.getByRole('radio', { name: 'Random' })).toBeChecked();
    await expect.element(page.getByRole('radio', { name: 'Custom' })).not.toBeChecked();
    await expect.element(page.getByPlaceholder('Random')).toHaveValue('');
  });

  test('a numeric value renders as Custom and shows the seed', async () => {
    renderWithProviders(<SeedInput value={42} onChange={vi.fn()} />);

    await expect.element(page.getByRole('radio', { name: 'Custom' })).toBeChecked();
    await expect.element(page.getByPlaceholder('Random')).toHaveValue('42');
  });

  test('switching to Custom emits a fresh random seed in [0, MAX_RANDOM_SEED]', async () => {
    // Stub Math.random for a deterministic, exact-value assertion (gives the
    // test teeth: a constant or wrong-bound emit fails). Component computes
    // Math.floor(Math.random() * MAX_RANDOM_SEED).
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const onChange = vi.fn();
      renderWithProviders(<SeedInput value={undefined} onChange={onChange} />);

      await userEvent.click(page.getByText('Custom'));

      expect(onChange).toHaveBeenCalledTimes(1);
      const seed = onChange.mock.calls[0][0];
      expect(seed).toBe(Math.floor(0.5 * MAX_RANDOM_SEED));
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(MAX_RANDOM_SEED);
    } finally {
      randomSpy.mockRestore();
    }
  });

  test('switching to Random clears the seed (emits undefined)', async () => {
    const onChange = vi.fn();
    renderWithProviders(<SeedInput value={123} onChange={onChange} />);

    await userEvent.click(page.getByText('Random'));

    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  test('typing a seed above MAX_SEED clamps to MAX_SEED', async () => {
    const onChange = vi.fn();
    renderWithProviders(<SeedInput value={1} onChange={onChange} />);

    await userEvent.fill(page.getByPlaceholder('Random'), '999999999999'); // > MAX_SEED

    const lastEmitted = onChange.mock.calls.at(-1)?.[0];
    expect(lastEmitted).toBe(MAX_SEED);
  });

  test('clearing the number field emits undefined', async () => {
    const onChange = vi.fn();
    renderWithProviders(<SeedInput value={5} onChange={onChange} />);

    await userEvent.clear(page.getByPlaceholder('Random'));

    expect(onChange).toHaveBeenCalledWith(undefined);
  });
});
