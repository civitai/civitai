import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import {
  CIVITAI_CLI_GITHUB_URL,
  CLI_CREATE_COMMAND,
  CLI_INSTALL_COMMAND,
  CLI_SUBMIT_COMMAND,
  CliSubmitCta,
} from '~/components/Apps/CliSubmitCta';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

// CliSubmitCta is the PRIMARY (recommended) submit path on /apps/submit. It is a
// pure presentational component (props-only, no tRPC / no network), so it renders
// in isolation. The manual ZIP-upload flow is a separate, de-emphasized section
// on the page (covered indirectly here by asserting this CTA is the CLI promo).
//
// NOTE: this env does not load `@mantine/core/styles.css`, so we assert
// presence / hrefs / accessible names — never computed styles.

describe('CliSubmitCta (CLI-first submit primary CTA)', () => {
  test('promotes the Civitai CLI as the recommended path', async () => {
    renderWithProviders(<CliSubmitCta />);
    await expect.element(page.getByText('Recommended: use the Civitai CLI')).toBeInTheDocument();
  });

  test('renders the "Get the Civitai CLI" button linking to github.com/civitai/cli', async () => {
    renderWithProviders(<CliSubmitCta />);
    const cta = page.getByRole('link', { name: 'Get the Civitai CLI' });
    await expect.element(cta).toBeInTheDocument();
    const href = cta.element().getAttribute('href');
    expect(href).toBe(CIVITAI_CLI_GITHUB_URL);
    expect(href).toContain('github.com/civitai/cli');
  });

  test('the GitHub link opens in a new tab with rel=noopener noreferrer', async () => {
    renderWithProviders(<CliSubmitCta />);
    const cta = page.getByRole('link', { name: 'Get the Civitai CLI' });
    // Await the render to settle before reading attributes synchronously.
    await expect.element(cta).toBeInTheDocument();
    const el = cta.element();
    expect(el.getAttribute('target')).toBe('_blank');
    expect(el.getAttribute('rel')).toContain('noopener');
    expect(el.getAttribute('rel')).toContain('noreferrer');
  });

  test('shows the install + create + submit one-liners', async () => {
    renderWithProviders(<CliSubmitCta />);
    // Commands are rendered prefixed with a shell prompt ("$ ").
    await expect.element(page.getByText(`$ ${CLI_INSTALL_COMMAND}`)).toBeInTheDocument();
    await expect.element(page.getByText(`$ ${CLI_CREATE_COMMAND}`)).toBeInTheDocument();
    await expect.element(page.getByText(`$ ${CLI_SUBMIT_COMMAND}`)).toBeInTheDocument();
  });

  test('the install command is the brew tap one-liner', async () => {
    expect(CLI_INSTALL_COMMAND).toBe('brew install civitai/tap/civitai');
    expect(CLI_CREATE_COMMAND).toBe('civitai app create');
    expect(CLI_SUBMIT_COMMAND).toBe('civitai app submit');
  });

  test('each command has a copy affordance with an accessible name', async () => {
    renderWithProviders(<CliSubmitCta />);
    for (const command of [CLI_INSTALL_COMMAND, CLI_CREATE_COMMAND, CLI_SUBMIT_COMMAND]) {
      await expect
        .element(page.getByRole('button', { name: `Copy command: ${command}` }))
        .toBeInTheDocument();
    }
  });
});
