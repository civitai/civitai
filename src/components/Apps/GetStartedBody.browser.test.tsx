import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { GetStartedBody } from '~/components/Apps/GetStartedBody';
import {
  APP_SDK_NPM_URL,
  BLOCKS_REACT_NPM_URL,
  CIVITAI_CLI_GITHUB_URL,
} from '~/components/Apps/cliCommands';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

// GetStartedBody is the PUBLIC "App builders" landing body — what a viewer WITHOUT builder
// access sees. Pure presentational (no props, no tRPC / no network) so it renders in isolation.
//
// NOTE: this env does not load `@mantine/core/styles.css`, so we assert
// presence / hrefs / accessible names / text — never computed styles.

// Literal on purpose: these are the contract the page's other suites and the stories share,
// and importing them from the component would let a rename pass unnoticed.
const AGENT_CARD = 'apps-agent-onboarding';
const MANUAL_TOGGLE = 'apps-manual-setup-toggle';
const MANUAL_REGION = 'apps-manual-setup';

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

  test('🔴 the order is hero, banner, "What you get"', async () => {
    await renderWithProviders(<GetStartedBody />);
    const located = [
      page.getByRole('heading', { name: 'Build on Civitai', level: 1 }),
      page.getByRole('img', { name: 'Build apps on Civitai' }),
      page.getByRole('heading', { name: 'What you get' }),
    ];
    for (const locator of located) await expect.element(locator).toBeInTheDocument();

    const order = located.map((locator) => locator.element());
    for (let i = 1; i < order.length; i++) {
      expect(follows(order[i - 1], order[i]), `element ${i} must follow element ${i - 1}`).toBe(
        true
      );
    }
  });

  /**
   * 🔴 NO BUILD ROUTE BEFORE ACCESS. This body is the pitch a viewer without builder access
   * sees; the agent prompt and the CLI steps both need access, so neither is offered here.
   *
   * Asserted on PRESENCE in the DOM, not visibility: Mantine's `Collapse` keeps its children
   * mounted while closed, so a collapsed manual setup would still be in the tree and a
   * visibility check would miss it. `Copy command: …` is `CopyableCommand`'s `aria-label`
   * contract, so it catches the CLI steps in ANY wrapper, not just the old collapse's test ids
   * — queried on the raw DOM because `getByRole` skips what a closed `Collapse` hides.
   */
  test('🔴 renders NO agent card and NO manual CLI setup', async () => {
    await renderWithProviders(<GetStartedBody />);
    // Render barrier: an absence assertion before the commit would read an empty container.
    await expect.element(page.getByRole('heading', { name: 'What you get' })).toBeInTheDocument();

    expect(page.getByTestId(AGENT_CARD).elements()).toHaveLength(0);
    expect(page.getByTestId(MANUAL_TOGGLE).elements()).toHaveLength(0);
    expect(page.getByTestId(MANUAL_REGION).elements()).toHaveLength(0);
    expect(document.querySelectorAll('[aria-label^="Copy command: "]')).toHaveLength(0);
  });

  test('renders the platform-capabilities grid (catalog / hosting / identity)', async () => {
    renderWithProviders(<GetStartedBody />);
    await expect.element(page.getByText('A huge model catalog')).toBeInTheDocument();
    await expect.element(page.getByText('Hosting handled')).toBeInTheDocument();
    await expect.element(page.getByText('Built-in identity')).toBeInTheDocument();
  });

  test('links to the real CLI repo and both npm packages', async () => {
    await renderWithProviders(<GetStartedBody />);

    // One "Civitai CLI" link: the toolkit button. The manual setup's intro line, which held
    // the second, is no longer on this page.
    const cliLinks = page.getByRole('link', { name: 'Civitai CLI' });
    await expect.element(cliLinks.first()).toBeVisible();
    const hrefs = cliLinks.elements().map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual([CIVITAI_CLI_GITHUB_URL]);

    const blocksReact = page.getByRole('link', { name: '@civitai/blocks-react' });
    await expect.element(blocksReact).toBeInTheDocument();
    expect(blocksReact.element().getAttribute('href')).toBe(BLOCKS_REACT_NPM_URL);

    const appSdk = page.getByRole('link', { name: '@civitai/app-sdk' });
    await expect.element(appSdk).toBeInTheDocument();
    expect(appSdk.element().getAttribute('href')).toBe(APP_SDK_NPM_URL);
  });
});
