import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { GetStartedBody } from '~/components/Apps/GetStartedBody';
import {
  APP_SDK_NPM_URL,
  BLOCKS_REACT_NPM_URL,
  CIVITAI_CLI_GITHUB_URL,
  CLI_CREATE_SAMPLE_COMMAND,
  CLI_INSTALL_BREW,
  CLI_INSTALL_GO,
  CLI_RUN_COMMAND,
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
      .element(page.getByRole('heading', { name: 'Build on Civitai', level: 1 }))
      .toBeInTheDocument();
  });

  test('renders the two section headings (quickstart / what you get) and NOT publish', async () => {
    renderWithProviders(<GetStartedBody />);
    await expect.element(page.getByRole('heading', { name: 'Quickstart' })).toBeInTheDocument();
    await expect.element(page.getByRole('heading', { name: 'What you get' })).toBeInTheDocument();
    // Publishing was removed from this page entirely.
    expect(page.getByRole('heading', { name: 'Publish' }).elements()).toHaveLength(0);
  });

  test('shows the quickstart commands (brew install, scaffold, run)', async () => {
    renderWithProviders(<GetStartedBody />);
    // Copyable commands render prefixed with a shell prompt ("$ ").
    for (const command of [CLI_INSTALL_BREW, CLI_CREATE_SAMPLE_COMMAND, CLI_RUN_COMMAND]) {
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
  });

  test('renders the platform-capabilities grid (catalog / hosting / identity)', async () => {
    renderWithProviders(<GetStartedBody />);
    await expect.element(page.getByText('A huge model catalog')).toBeInTheDocument();
    await expect.element(page.getByText('Hosting handled')).toBeInTheDocument();
    await expect.element(page.getByText('Built-in identity')).toBeInTheDocument();
  });

  test('links to the real CLI repo and both npm packages', async () => {
    renderWithProviders(<GetStartedBody />);
    // Two "Civitai CLI" links render now (the quickstart subtitle Anchor + the
    // toolkit Button) — both point at the same repo. Assert the toolkit one
    // (the second match) via the retrying element API, then confirm every
    // rendered "Civitai CLI" link targets the CLI repo.
    const toolkitCli = page.getByRole('link', { name: 'Civitai CLI' }).nth(1);
    await expect.element(toolkitCli).toBeInTheDocument();
    expect(toolkitCli.element().getAttribute('href')).toBe(CIVITAI_CLI_GITHUB_URL);
    for (const link of page.getByRole('link', { name: 'Civitai CLI' }).elements()) {
      expect(link.getAttribute('href')).toBe(CIVITAI_CLI_GITHUB_URL);
    }

    const blocksReact = page.getByRole('link', { name: '@civitai/blocks-react' });
    await expect.element(blocksReact).toBeInTheDocument();
    expect(blocksReact.element().getAttribute('href')).toBe(BLOCKS_REACT_NPM_URL);

    const appSdk = page.getByRole('link', { name: '@civitai/app-sdk' });
    await expect.element(appSdk).toBeInTheDocument();
    expect(appSdk.element().getAttribute('href')).toBe(APP_SDK_NPM_URL);
  });

  test('the Quickstart subtitle pitches a 3-step local app and links to the CLI repo', async () => {
    renderWithProviders(<GetStartedBody />);
    await expect
      .element(page.getByText('Create a local Civitai app in 3 steps', { exact: false }))
      .toBeInTheDocument();
    const ghLink = page.getByRole('link', { name: 'Civitai CLI' }).first();
    await expect.element(ghLink).toBeInTheDocument();
    expect(ghLink.element().getAttribute('href')).toBe(CIVITAI_CLI_GITHUB_URL);
  });
});
