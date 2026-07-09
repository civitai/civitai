import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { SubmitModeSelector, type SubmitMode } from '~/components/Apps/SubmitModeSelector';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * W13 — /apps/submit type-picker cards. Browser-mode surface test (report-only
 * in Tekton): both type cards render, and clicking each fires `onSelect` with the
 * right mode id (the on-platform "App" keeps the historical `block` id).
 * Presentational + props-only, so it renders in isolation (no tRPC / no server).
 */
describe('SubmitModeSelector', () => {
  test('renders both type cards (App + External link)', async () => {
    renderWithProviders(<SubmitModeSelector onSelect={vi.fn()} />);
    await expect.element(page.getByTestId('apps-submit-mode-card-app')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-submit-mode-card-external')).toBeInTheDocument();
    await expect.element(page.getByText('App', { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText('External link', { exact: true })).toBeInTheDocument();
  });

  test('picking "App" calls onSelect("block") — code id unchanged', async () => {
    const onSelect = vi.fn<(mode: SubmitMode) => void>();
    renderWithProviders(<SubmitModeSelector onSelect={onSelect} />);
    await page.getByTestId('apps-submit-mode-card-app').click();
    expect(onSelect).toHaveBeenCalledWith('block');
  });

  test('picking "External link" calls onSelect("external")', async () => {
    const onSelect = vi.fn<(mode: SubmitMode) => void>();
    renderWithProviders(<SubmitModeSelector onSelect={onSelect} />);
    await page.getByTestId('apps-submit-mode-card-external').click();
    expect(onSelect).toHaveBeenCalledWith('external');
  });
});
