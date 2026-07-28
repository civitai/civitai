import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { BlockScopeSelector } from './BlockScopeSelector';

/**
 * BlockScopeSelector — browser-mode render test (report-only in Tekton).
 *
 * Pins that the manifest-editor scope checklist renders the known scope
 * vocabulary, flags sensitive scopes with the shared "Sensitive" badge, toggles
 * selection, and preserves a legacy/unknown scope carried by an existing manifest.
 */
describe('BlockScopeSelector', () => {
  test('renders known scopes as checkboxes with the sensitive badge on sensitive ones', async () => {
    renderWithProviders(<BlockScopeSelector value={[]} onChange={vi.fn()} />);
    // A non-sensitive and a sensitive known scope both render as checkboxes.
    await expect
      .element(page.getByRole('checkbox', { name: 'user:read:self' }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole('checkbox', { name: 'ai:write:budgeted' }))
      .toBeInTheDocument();
    // At least one sensitive badge is present (ai:write:budgeted / social:tip:self / …).
    expect(page.getByTestId('sensitive-scope-badge').elements().length).toBeGreaterThan(0);
  });

  test('reflects the current selection as checked', async () => {
    renderWithProviders(
      <BlockScopeSelector value={['models:read:self']} onChange={vi.fn()} />
    );
    await expect
      .element(page.getByRole('checkbox', { name: 'models:read:self' }))
      .toBeChecked();
    await expect
      .element(page.getByRole('checkbox', { name: 'user:read:self' }))
      .not.toBeChecked();
  });

  test('toggling a scope calls onChange with the updated selection', async () => {
    const onChange = vi.fn();
    renderWithProviders(<BlockScopeSelector value={[]} onChange={onChange} />);
    await userEvent.click(page.getByRole('checkbox', { name: 'user:read:self' }));
    expect(onChange).toHaveBeenCalledWith(['user:read:self']);
  });

  test('preserves a legacy/unknown selected scope as a checked, removable row', async () => {
    renderWithProviders(
      <BlockScopeSelector value={['media:read:owned']} onChange={vi.fn()} />
    );
    // media:read:owned is a retired scope no longer in the registry — still shown, checked.
    await expect
      .element(page.getByRole('checkbox', { name: 'media:read:owned' }))
      .toBeChecked();
    await expect.element(page.getByText('legacy')).toBeInTheDocument();
  });
});
