import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import {
  GetStartedBody,
  REQUEST_ACCESS_HREF,
  REQUEST_ACCESS_TITLE,
} from '~/components/Apps/GetStartedBody';
import {
  APP_SDK_NPM_URL,
  BLOCKS_REACT_NPM_URL,
  CIVITAI_CLI_GITHUB_URL,
  CLI_CREATE_SAMPLE_COMMAND,
  CLI_INSTALL_BREW,
  CLI_INSTALL_GO,
  CLI_RUN_COMMAND,
  CLI_SUBMIT_COMMAND,
} from '~/components/Apps/cliCommands';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

// GetStartedBody is the PUBLIC "App builders" landing body. Pure presentational
// (props-only, no tRPC / no network) so it renders in isolation.
//
// NOTE: this env does not load `@mantine/core/styles.css`, so we assert
// presence / hrefs / accessible names / text — never computed styles.
describe('GetStartedBody (public App builders landing)', () => {
  test('renders the hero heading', async () => {
    renderWithProviders(<GetStartedBody />);
    await expect
      .element(page.getByRole('heading', { name: 'Build apps on Civitai', level: 1 }))
      .toBeInTheDocument();
  });

  test('renders the three section headings (quickstart / what you get / publish)', async () => {
    renderWithProviders(<GetStartedBody />);
    await expect.element(page.getByRole('heading', { name: 'Quickstart' })).toBeInTheDocument();
    await expect.element(page.getByRole('heading', { name: 'What you get' })).toBeInTheDocument();
    await expect.element(page.getByRole('heading', { name: 'Publish' })).toBeInTheDocument();
  });

  test('honest framing: states publishing is in private beta', async () => {
    renderWithProviders(<GetStartedBody />);
    await expect.element(page.getByText('Publishing is in private beta.')).toBeInTheDocument();
  });

  test('shows the quickstart commands (brew install, scaffold, run) and the submit command', async () => {
    renderWithProviders(<GetStartedBody />);
    // Copyable commands render prefixed with a shell prompt ("$ ").
    for (const command of [
      CLI_INSTALL_BREW,
      CLI_CREATE_SAMPLE_COMMAND,
      CLI_RUN_COMMAND,
      CLI_SUBMIT_COMMAND,
    ]) {
      await expect.element(page.getByText(`$ ${command}`)).toBeInTheDocument();
    }
    // The Go install is shown inline (secondary option), not as a copyable block.
    await expect.element(page.getByText(CLI_INSTALL_GO)).toBeInTheDocument();
  });

  test('the run command installs deps before dev:harness (the CLI does not auto-install)', () => {
    // Guards the correctness fix: `create` does NOT install deps, so the run step
    // MUST include `npm install`, and uses `dev:harness` (mock host), not `dev`.
    expect(CLI_RUN_COMMAND).toContain('npm install');
    expect(CLI_RUN_COMMAND).toContain('npm run dev:harness');
  });

  test('command constants are the real, verified one-liners', () => {
    expect(CLI_INSTALL_BREW).toBe('brew install civitai/tap/civitai');
    expect(CLI_INSTALL_GO).toBe('go install github.com/civitai/cli/cmd/civitai@latest');
    expect(CLI_CREATE_SAMPLE_COMMAND).toBe('civitai app create my-app');
    expect(CLI_RUN_COMMAND).toBe('cd my-app && npm install && npm run dev:harness');
    expect(CLI_SUBMIT_COMMAND).toBe('civitai app submit');
  });

  test('renders the platform-capabilities grid (catalog / hosting / identity)', async () => {
    renderWithProviders(<GetStartedBody />);
    await expect.element(page.getByText('A huge model catalog')).toBeInTheDocument();
    await expect.element(page.getByText('Hosting handled')).toBeInTheDocument();
    await expect.element(page.getByText('Built-in identity')).toBeInTheDocument();
  });

  test('links to the real CLI repo and both npm packages', async () => {
    renderWithProviders(<GetStartedBody />);
    const cli = page.getByRole('link', { name: 'Civitai CLI' });
    await expect.element(cli).toBeInTheDocument();
    expect(cli.element().getAttribute('href')).toBe(CIVITAI_CLI_GITHUB_URL);

    const blocksReact = page.getByRole('link', { name: '@civitai/blocks-react' });
    await expect.element(blocksReact).toBeInTheDocument();
    expect(blocksReact.element().getAttribute('href')).toBe(BLOCKS_REACT_NPM_URL);

    const appSdk = page.getByRole('link', { name: '@civitai/app-sdk' });
    await expect.element(appSdk).toBeInTheDocument();
    expect(appSdk.element().getAttribute('href')).toBe(APP_SDK_NPM_URL);
  });

  test('renders the Request-access CTA wired to a prefilled civitai/cli issue', async () => {
    renderWithProviders(<GetStartedBody />);
    const cta = page.getByRole('link', { name: 'Request access on GitHub' });
    await expect.element(cta).toBeInTheDocument();
    expect(cta.element().getAttribute('href')).toBe(REQUEST_ACCESS_HREF);
    // Points at a well-formed prefilled new-issue on the public CLI repo
    // (no longer the `#` placeholder).
    expect(REQUEST_ACCESS_HREF).toMatch(
      /^https:\/\/github\.com\/civitai\/cli\/issues\/new\?/
    );
    expect(REQUEST_ACCESS_HREF).toContain(`title=${encodeURIComponent(REQUEST_ACCESS_TITLE)}`);
    expect(REQUEST_ACCESS_HREF).toContain('&body=');
  });
});
