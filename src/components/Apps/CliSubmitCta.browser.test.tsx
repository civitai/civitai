import { describe, expect, test } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { CliSubmitCta } from '~/components/Apps/CliSubmitCta';
import {
  CIVITAI_CLI_GITHUB_URL,
  CLI_CREATE_COMMAND,
  CLI_CREATE_SAMPLE_COMMAND,
  CLI_INSTALL_BREW,
  CLI_SUBMIT_COMMAND,
} from '~/components/Apps/cliCommands';
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
    await expect.element(page.getByText(`$ ${CLI_INSTALL_BREW}`)).toBeInTheDocument();
    await expect.element(page.getByText(`$ ${CLI_CREATE_COMMAND}`)).toBeInTheDocument();
    await expect.element(page.getByText(`$ ${CLI_SUBMIT_COMMAND}`)).toBeInTheDocument();
  });

  test('the install command is the brew tap one-liner', async () => {
    expect(CLI_INSTALL_BREW).toBe('brew install civitai/tap/civitai');
    expect(CLI_CREATE_COMMAND).toBe('civitai app create');
    expect(CLI_SUBMIT_COMMAND).toBe('civitai app submit');
  });

  // The shared cliCommands module exposes BOTH create forms: the bare
  // `civitai app create` (this CTA) and the with-sample-name
  // `civitai app create my-app` (the get-started quickstart). Pin both so a
  // change to either is a deliberate, reviewed edit.
  test('the shared module exposes both create forms as the real one-liners', () => {
    expect(CLI_CREATE_COMMAND).toBe('civitai app create');
    expect(CLI_CREATE_SAMPLE_COMMAND).toBe('civitai app create my-app');
  });

  test('each command has a copy affordance with an accessible name', async () => {
    renderWithProviders(<CliSubmitCta />);
    for (const command of [CLI_INSTALL_BREW, CLI_CREATE_COMMAND, CLI_SUBMIT_COMMAND]) {
      await expect
        .element(page.getByRole('button', { name: `Copy command: ${command}` }))
        .toBeInTheDocument();
    }
  });

  // M1 (a11y): the copy must WORK when the real <button aria-label="Copy …"> is
  // operated — both by mouse and by keyboard (the path a keyboard / screen-reader
  // user takes). The fix moves `onClick={copy}` onto the LegacyActionIcon button
  // (canonical Mantine CopyButton pattern, see CivitaiLinkWizard) so the button is
  // independently functional rather than relying on its click bubbling to the
  // wrapping <Box onClick>.
  //
  // HONEST CAVEAT ON MUTATION-SENSITIVITY: the button is a DOM descendant of the
  // <Box>, and BOTH handlers are React-synthetic (dispatched at the delegated
  // React root). A mouse click and a native keyboard-Enter both bubble to that
  // shared root, so React fires whichever onClick is present — the copy succeeds
  // whether the handler sits on the button or only on the Box. There is therefore
  // NO observable behavioral differential a DOM-level test can isolate (a
  // DOM-level stopPropagation kills BOTH handlers, since it stops the event before
  // it reaches the React root). These tests assert the real user-facing
  // guarantee — the button is focusable and copy fires on mouse + keyboard — and
  // document that the fix is canonical-pattern hardening, not a behavior change.
  test('clicking the copy button copies — shows "Copied"', async () => {
    renderWithProviders(<CliSubmitCta />);
    const button = page.getByRole('button', { name: `Copy command: ${CLI_INSTALL_BREW}` });
    await expect.element(button).toBeInTheDocument();
    await button.click();
    // CopyButton flips its render-prop `copied` → the Code block text becomes
    // "Copied" iff the activation triggered the `copy()` callback.
    await expect.element(page.getByText('Copied')).toBeInTheDocument();
  });

  test('the copy button is focusable and keyboard-Enter copies — shows "Copied"', async () => {
    renderWithProviders(<CliSubmitCta />);
    const button = page.getByRole('button', { name: `Copy command: ${CLI_SUBMIT_COMMAND}` });
    await expect.element(button).toBeInTheDocument();
    const el = button.element() as HTMLElement;
    el.focus();
    expect(document.activeElement).toBe(el); // genuinely keyboard-reachable
    await userEvent.keyboard('{Enter}');
    await expect.element(page.getByText('Copied')).toBeInTheDocument();
  });
});
