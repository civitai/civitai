import { describe, expect, test, vi } from 'vitest';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
import { ReviewsPager } from './ReviewsPager';

describe('ReviewsPager', () => {
  test('Next asks for the following page', async () => {
    const onChange = vi.fn();
    const screen = await renderWithProviders(<ReviewsPager page={2} hasMore onChange={onChange} />);
    await screen.getByRole('button', { name: 'Next' }).click();
    expect(onChange).toHaveBeenCalledWith(3);
  });

  test('Previous asks for the page before', async () => {
    const onChange = vi.fn();
    const screen = await renderWithProviders(<ReviewsPager page={2} hasMore onChange={onChange} />);
    await screen.getByRole('button', { name: 'Previous' }).click();
    expect(onChange).toHaveBeenCalledWith(1);
  });

  test('Previous is disabled on the first page', async () => {
    const screen = await renderWithProviders(<ReviewsPager page={1} hasMore onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Previous' }).element()).toHaveProperty(
      'disabled',
      true
    );
    expect(screen.getByRole('button', { name: 'Next' }).element()).toHaveProperty(
      'disabled',
      false
    );
  });

  test('Next is disabled on the last page', async () => {
    const screen = await renderWithProviders(
      <ReviewsPager page={3} hasMore={false} onChange={vi.fn()} />
    );
    expect(screen.getByRole('button', { name: 'Next' }).element()).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Previous' }).element()).toHaveProperty(
      'disabled',
      false
    );
  });

  test('renders nothing when there is a single page', async () => {
    const screen = await renderWithProviders(
      <ReviewsPager page={1} hasMore={false} onChange={vi.fn()} />
    );
    expect(screen.getByRole('button').elements()).toHaveLength(0);
  });
});
