import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { ManualUploadSection } from '~/components/Apps/ManualUploadSection';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

// ManualUploadSection is the SECONDARY (de-emphasized) submit path on
// /apps/submit — the CLI is primary. It owns only the collapse / visual-demotion
// chrome; the real upload form is passed as children (kept on the page so its
// state/mutations stay intact). These tests prove the manual path is still
// PRESENT and FUNCTIONAL (children render once expanded), just demoted.
//
// NOTE: this env does not load `@mantine/core/styles.css` — assert presence /
// aria-expanded / children visibility, never computed styles.

const CHILD = <div data-testid="manual-upload-form">upload form</div>;

describe('ManualUploadSection (secondary manual ZIP upload)', () => {
  test('renders an "or upload manually" divider so the path is discoverable', async () => {
    renderWithProviders(<ManualUploadSection>{CHILD}</ManualUploadSection>);
    await expect.element(page.getByText('or upload manually')).toBeInTheDocument();
  });

  test('is collapsed by default — the upload form is hidden behind the toggle', async () => {
    renderWithProviders(<ManualUploadSection>{CHILD}</ManualUploadSection>);
    const toggle = page.getByRole('button', { name: 'Upload a ZIP manually' });
    await expect.element(toggle).toBeInTheDocument();
    expect(toggle.element().getAttribute('aria-expanded')).toBe('false');
  });

  test('expanding the toggle reveals the upload form (still functional, just demoted)', async () => {
    renderWithProviders(<ManualUploadSection>{CHILD}</ManualUploadSection>);
    const toggle = page.getByRole('button', { name: 'Upload a ZIP manually' });
    await toggle.click();
    // Children (the real upload form) render and the toggle flips to "Hide".
    await expect.element(page.getByTestId('manual-upload-form')).toBeInTheDocument();
    await expect
      .element(page.getByRole('button', { name: 'Hide manual ZIP upload' }))
      .toBeInTheDocument();
  });

  test('defaultOpen keeps the section open so a selected bundle is not lost', async () => {
    renderWithProviders(<ManualUploadSection defaultOpen>{CHILD}</ManualUploadSection>);
    const toggle = page.getByRole('button', { name: 'Hide manual ZIP upload' });
    await expect.element(toggle).toBeInTheDocument();
    expect(toggle.element().getAttribute('aria-expanded')).toBe('true');
    await expect.element(page.getByTestId('manual-upload-form')).toBeInTheDocument();
  });
});
