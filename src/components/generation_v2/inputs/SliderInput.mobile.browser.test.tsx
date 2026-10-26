import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import { SliderInput } from '~/components/generation_v2/inputs/SliderInput';
import type * as MobileGenerator from '~/hooks/useMobileGenerator';

// The mobile generator's layout of the slider: the flag and a phone window, which the test browser
// has neither of.
vi.mock('~/hooks/useMobileGenerator', async (importOriginal) => ({
  ...(await importOriginal<typeof MobileGenerator>()),
  useMobileGenerator: () => true,
}));

const renderCfg = (recommended?: { min: number; max: number }) =>
  renderWithProviders(
    <SliderInput
      label="CFG Scale"
      value={5}
      min={1}
      max={15}
      step={0.5}
      recommended={recommended}
      onChange={vi.fn()}
    />
  );

describe('SliderInput in the mobile generator', () => {
  test('names the recommended range under the track', async () => {
    renderCfg({ min: 4, max: 7 });
    await expect.element(page.getByText('Recommended: 4.0–7.0')).toBeInTheDocument();
  });

  test('names a single recommended value when the range has no width', async () => {
    renderCfg({ min: 1, max: 1 });
    await expect.element(page.getByText('Recommended: 1.0', { exact: true })).toBeInTheDocument();
  });

  test('says nothing when no range is recommended', async () => {
    renderCfg();
    await expect.element(page.getByRole('slider', { name: 'CFG Scale' })).toBeInTheDocument();
    await expect.element(page.getByText(/^Recommended/)).not.toBeInTheDocument();
  });
});
