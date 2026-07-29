import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { SubmitModeSelector, type SubmitMode } from '~/components/Apps/SubmitModeSelector';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * W13 — /apps/submit type-picker cards. Browser-mode surface test (report-only
 * in Tekton): both type cards render, and clicking each fires `onSelect` with the
 * right mode id (the on-platform "App" keeps the historical `block` id). The former
 * separate "Connect an app" card was MERGED into the External card (every external
 * app IS an OAuth app). Presentational + props-only, so it renders in isolation.
 */
describe('SubmitModeSelector', () => {
  test('renders both type cards (App + external app), no separate Connect card', async () => {
    renderWithProviders(<SubmitModeSelector onSelect={vi.fn()} />);
    await expect.element(page.getByTestId('apps-submit-mode-card-app')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-submit-mode-card-external')).toBeInTheDocument();
    await expect.element(page.getByText('App', { exact: true })).toBeInTheDocument();
    await expect
      .element(page.getByText('List an external app (connect your OAuth app)', { exact: true }))
      .toBeInTheDocument();
    // The merged model has no standalone connect card.
    expect(document.querySelector('[data-testid="apps-submit-mode-card-connect"]')).toBeNull();
  });

  test('picking "App" calls onSelect("block") — code id unchanged', async () => {
    const onSelect = vi.fn<(mode: SubmitMode) => void>();
    renderWithProviders(<SubmitModeSelector onSelect={onSelect} />);
    await page.getByTestId('apps-submit-mode-card-app').click();
    expect(onSelect).toHaveBeenCalledWith('block');
  });

  test('picking the external-app card calls onSelect("external")', async () => {
    const onSelect = vi.fn<(mode: SubmitMode) => void>();
    renderWithProviders(<SubmitModeSelector onSelect={onSelect} />);
    await page.getByTestId('apps-submit-mode-card-external').click();
    expect(onSelect).toHaveBeenCalledWith('external');
  });
});
