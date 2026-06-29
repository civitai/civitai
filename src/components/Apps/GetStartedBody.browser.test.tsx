import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import {
  APP_SDK_NPM_URL,
  BLOCKS_REACT_NPM_URL,
  CIVITAI_CLI_GITHUB_URL,
  CLI_CREATE_COMMAND,
  CLI_DEV_HARNESS_COMMAND,
  CLI_INSTALL_BREW,
  CLI_INSTALL_GO,
  CLI_SUBMIT_COMMAND,
  GetStartedBody,
  REQUEST_ACCESS_HREF,
  SDK_INSTALL_COMMAND,
} from '~/components/Apps/GetStartedBody';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

// GetStartedBody is the PUBLIC "App builders" landing body. Pure presentational
// (props-only, no tRPC / no network) so it renders in isolation.
//
// NOTE: this env does not load `@mantine/core/styles.css`, so we assert
// presence / hrefs / accessible names — never computed styles.
describe('GetStartedBody (public App builders landing)', () => {
  test('renders the hero heading', async () => {
    renderWithProviders(<GetStartedBody />);
    await expect
      .element(page.getByRole('heading', { name: 'Build apps on Civitai', level: 1 }))
      .toBeInTheDocument();
  });

  test('renders the three content section headings (tools / process / today)', async () => {
    renderWithProviders(<GetStartedBody />);
    await expect.element(page.getByRole('heading', { name: 'The tools' })).toBeInTheDocument();
    await expect.element(page.getByRole('heading', { name: 'The process' })).toBeInTheDocument();
    await expect
      .element(page.getByRole('heading', { name: 'What you can do today' }))
      .toBeInTheDocument();
  });

  test('honest framing: states publishing is in private beta', async () => {
    renderWithProviders(<GetStartedBody />);
    await expect
      .element(page.getByText('Publishing is in private beta.'))
      .toBeInTheDocument();
  });

  test('shows the CLI install one-liners (brew + go), scaffold, harness, and submit commands', async () => {
    renderWithProviders(<GetStartedBody />);
    for (const command of [
      CLI_INSTALL_BREW,
      CLI_INSTALL_GO,
      CLI_CREATE_COMMAND,
      CLI_DEV_HARNESS_COMMAND,
      SDK_INSTALL_COMMAND,
      CLI_SUBMIT_COMMAND,
    ]) {
      // Commands render prefixed with a shell prompt ("$ ").
      await expect.element(page.getByText(`$ ${command}`)).toBeInTheDocument();
    }
  });

  test('command constants are the real, verified one-liners', () => {
    expect(CLI_INSTALL_BREW).toBe('brew install civitai/tap/civitai');
    expect(CLI_INSTALL_GO).toBe('go install github.com/civitai/cli/cmd/civitai@latest');
    expect(CLI_CREATE_COMMAND).toBe('civitai app create');
    expect(CLI_DEV_HARNESS_COMMAND).toBe('npm run dev:harness');
    expect(CLI_SUBMIT_COMMAND).toBe('civitai app submit');
    expect(SDK_INSTALL_COMMAND).toBe('npm install @civitai/blocks-react @civitai/app-sdk');
  });

  test('links to the real CLI repo and both npm packages', async () => {
    renderWithProviders(<GetStartedBody />);
    const cli = page.getByRole('link', { name: 'github.com/civitai/cli' });
    await expect.element(cli).toBeInTheDocument();
    expect(cli.element().getAttribute('href')).toBe(CIVITAI_CLI_GITHUB_URL);

    const blocksReact = page.getByRole('link', { name: '@civitai/blocks-react' });
    await expect.element(blocksReact).toBeInTheDocument();
    expect(blocksReact.element().getAttribute('href')).toBe(BLOCKS_REACT_NPM_URL);

    const appSdk = page.getByRole('link', { name: '@civitai/app-sdk' });
    await expect.element(appSdk).toBeInTheDocument();
    expect(appSdk.element().getAttribute('href')).toBe(APP_SDK_NPM_URL);
  });

  test('renders a Request-access CTA', async () => {
    renderWithProviders(<GetStartedBody />);
    // The hero has an inline "Request access" anchor; the primary CTA button is
    // labeled distinctly ("Request publishing access") so the two never collide.
    await expect
      .element(page.getByRole('link', { name: 'Request access' }))
      .toBeInTheDocument();
    const cta = page.getByRole('link', { name: 'Request publishing access' });
    await expect.element(cta).toBeInTheDocument();
    // The request-access link is a deliberate placeholder until the real form
    // exists — this pins that it is wired to the documented placeholder href.
    expect(cta.element().getAttribute('href')).toBe(REQUEST_ACCESS_HREF);
    expect(REQUEST_ACCESS_HREF).toBe('#');
  });
});
