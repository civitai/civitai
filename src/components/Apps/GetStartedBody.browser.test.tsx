import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { GetStartedBody } from '~/components/Apps/GetStartedBody';
import {
  AGENT_BUILD_PROMPT,
  APP_SDK_NPM_URL,
  BLOCKS_REACT_NPM_URL,
  CIVITAI_CLI_GITHUB_URL,
  CLI_CREATE_SAMPLE_COMMAND,
  CLI_INSTALL_BREW,
  CLI_INSTALL_GO,
  CLI_INSTALL_NPM,
  CLI_RUN_COMMAND,
} from '~/components/Apps/cliCommands';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

// GetStartedBody is the PUBLIC "App builders" landing body. Pure presentational
// (props-only, no tRPC / no network) so it renders in isolation.
//
// NOTE: this env does not load `@mantine/core/styles.css`, so we assert
// presence / hrefs / accessible names / text — never computed styles.

// Literal on purpose: these are the contract the page's other suites and the stories share,
// and importing them from the component would let a rename pass unnoticed.
const AGENT_CARD = 'apps-agent-onboarding';
const MANUAL_TOGGLE = 'apps-manual-setup-toggle';
const MANUAL_REGION = 'apps-manual-setup';
const NPM_INSTALL = 'npm install -g @civitai/cli';

/** True when `b` comes after `a` in document order. */
const follows = (a: Element, b: Element) =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('GetStartedBody (public App builders landing)', () => {
  test('renders the hero heading', async () => {
    renderWithProviders(<GetStartedBody />);
    await expect
      .element(page.getByRole('heading', { name: 'Build on Civitai', level: 1 }))
      .toBeInTheDocument();
  });

  test('renders the "What you get" heading and NOT publish', async () => {
    renderWithProviders(<GetStartedBody />);
    await expect.element(page.getByRole('heading', { name: 'What you get' })).toBeInTheDocument();
    // Publishing was removed from this page entirely.
    expect(page.getByRole('heading', { name: 'Publish' }).elements()).toHaveLength(0);
  });

  test('🔴 the order is hero, agent card, banner, "What you get", manual setup', async () => {
    await renderWithProviders(<GetStartedBody />);
    const hero = page.getByRole('heading', { name: 'Build on Civitai', level: 1 });
    const card = page.getByTestId(AGENT_CARD);
    const banner = page.getByRole('img', { name: 'Build apps on Civitai' });
    const whatYouGet = page.getByRole('heading', { name: 'What you get' });
    const manualToggle = page.getByTestId(MANUAL_TOGGLE);
    for (const locator of [hero, card, banner, whatYouGet, manualToggle]) {
      await expect.element(locator).toBeInTheDocument();
    }

    const order = [hero, card, banner, whatYouGet, manualToggle].map((l) => l.element());
    for (let i = 1; i < order.length; i++) {
      expect(follows(order[i - 1], order[i]), `element ${i} must follow element ${i - 1}`).toBe(
        true
      );
    }
  });

  test('🔴 the agent card precedes the manual commands, which are npm-first', async () => {
    await renderWithProviders(<GetStartedBody />);
    const card = page.getByTestId(AGENT_CARD);
    // Collapsed children stay mounted, so the command text is in the DOM while closed.
    const install = page.getByText(`$ ${NPM_INSTALL}`);
    await expect.element(card).toBeInTheDocument();
    await expect.element(install).toBeInTheDocument();
    expect(follows(card.element(), install.element())).toBe(true);
  });

  test('🔴 the manual setup is collapsed by default', async () => {
    await renderWithProviders(<GetStartedBody />);
    const toggle = page.getByTestId(MANUAL_TOGGLE);
    await expect.element(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect.element(toggle).toHaveTextContent('Set up manually with the CLI');
    // Mantine's <Collapse> renders a zero-height wrapper when closed, so assert THAT region.
    // Asserting an inner <pre> is unreliable: the browser matcher ignores the wrapper's
    // opacity and the clipped child keeps its own bounding box.
    await expect.element(page.getByTestId(MANUAL_REGION)).not.toBeVisible();
  });

  test('🔴 the toggle opens the manual setup, and closes it again', async () => {
    await renderWithProviders(<GetStartedBody />);
    const toggle = page.getByTestId(MANUAL_TOGGLE);
    const region = page.getByTestId(MANUAL_REGION);

    await toggle.click();
    await expect.element(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect.element(toggle).toHaveTextContent('Hide manual setup');
    await expect.element(region).toBeVisible();
    // Copyable commands render prefixed with a shell prompt ("$ ").
    for (const command of [
      NPM_INSTALL,
      'civitai app create my-app',
      'cd my-app && npm install && npm run dev:harness',
    ]) {
      await expect.element(page.getByText(`$ ${command}`)).toBeVisible();
    }
    // The other install routes are shown inline, not as copyable blocks.
    await expect.element(page.getByText('brew install civitai/tap/civitai')).toBeVisible();
    await expect
      .element(page.getByText('go install github.com/civitai/cli/cmd/civitai@latest'))
      .toBeVisible();
    expect(
      page
        .getByRole('button', { name: 'Copy command: brew install civitai/tap/civitai' })
        .elements()
    ).toHaveLength(0);

    await toggle.click();
    await expect.element(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect.element(region).not.toBeVisible();
  });

  test('🔴 each copy fires its OWN callback: commands to onCopyCommand, the prompt to onCopyAgentPrompt', async () => {
    const onCopyCommand = vi.fn();
    const onCopyAgentPrompt = vi.fn();
    await renderWithProviders(
      <GetStartedBody onCopyCommand={onCopyCommand} onCopyAgentPrompt={onCopyAgentPrompt} />
    );

    await page.getByRole('button', { name: 'Copy the agent setup prompt' }).click();
    expect(onCopyAgentPrompt.mock.calls).toEqual([[AGENT_BUILD_PROMPT]]);
    expect(onCopyCommand).not.toHaveBeenCalled();

    await page.getByTestId(MANUAL_TOGGLE).click();
    await expect.element(page.getByTestId(MANUAL_REGION)).toBeVisible();
    await page.getByRole('button', { name: `Copy command: ${NPM_INSTALL}` }).click();
    await page.getByRole('button', { name: 'Copy command: civitai app create my-app' }).click();
    expect(onCopyCommand.mock.calls).toEqual([[NPM_INSTALL], ['civitai app create my-app']]);
    expect(onCopyAgentPrompt).toHaveBeenCalledTimes(1);
  });

  test('the run command installs deps before dev:harness (the CLI does not auto-install)', () => {
    // Guards the correctness fix: `create` does NOT install deps, so the run step
    // MUST include `npm install`, and uses `dev:harness` (mock host), not `dev`.
    expect(CLI_RUN_COMMAND).toContain('npm install');
    expect(CLI_RUN_COMMAND).toContain('npm run dev:harness');
  });

  test('command constants are the real, verified one-liners', () => {
    expect(CLI_INSTALL_NPM).toBe('npm install -g @civitai/cli');
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
    await renderWithProviders(<GetStartedBody />);
    // Opened first: the second "Civitai CLI" link lives in the manual setup's intro line.
    await page.getByTestId(MANUAL_TOGGLE).click();
    await expect.element(page.getByTestId(MANUAL_REGION)).toBeVisible();

    const cliLinks = page.getByRole('link', { name: 'Civitai CLI' });
    await expect.element(cliLinks.nth(1)).toBeVisible();
    const hrefs = cliLinks.elements().map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual([CIVITAI_CLI_GITHUB_URL, CIVITAI_CLI_GITHUB_URL]);

    const blocksReact = page.getByRole('link', { name: '@civitai/blocks-react' });
    await expect.element(blocksReact).toBeInTheDocument();
    expect(blocksReact.element().getAttribute('href')).toBe(BLOCKS_REACT_NPM_URL);

    const appSdk = page.getByRole('link', { name: '@civitai/app-sdk' });
    await expect.element(appSdk).toBeInTheDocument();
    expect(appSdk.element().getAttribute('href')).toBe(APP_SDK_NPM_URL);
  });
});
