import { page } from 'vitest/browser';
import { describe, expect, test } from 'vitest';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { ConnectScopesDisclosure } from '~/components/Apps/ConnectScopesDisclosure';

/**
 * The PUBLIC store-page OAuth-scope disclosure.
 *
 * 🔴 WHY THIS FILE EXISTS: the component and its shared row shipped with NO test of any
 * kind, and an adversarial audit then found two defects living entirely inside that
 * untested region — a stranded-client case that put two contradictory security claims on
 * one public page, and a moderator-preview posture that told a reviewer their own
 * pending set was already approved. Twenty CI checks were green throughout. The server
 * projection was well covered; "the client half has no tests" was the actual gap.
 *
 * Browser tier is REPORT-ONLY in CI, so this cannot gate a merge — the stranded-client
 * case is *also* pinned at the node tier in `__tests__/appListingConnectScopes.test.ts`,
 * which is blocking. What only this tier can assert is what a viewer SEES.
 */
describe('ConnectScopesDisclosure', () => {
  test('renders nothing at all when there are no scopes — not an empty box', async () => {
    const { container } = await renderWithProviders(<ConnectScopesDisclosure scopes={[]} />);
    // The absence IS the requirement (clawgate #555 acceptance criterion 2): on a store
    // page "no permissions" is said by the section not being there. A reassuring empty
    // container would satisfy a `toBeInTheDocument` check and fail the actual ask.
    expect(container.querySelector('[data-testid="connect-scopes-disclosure"]')).toBeNull();
  });

  test('renders nothing when every key is unrecognised', async () => {
    // The decode drops keys `TokenScope` does not know; all-unknown must collapse to the
    // same "no section" state rather than an empty card with a count of zero.
    const { container } = await renderWithProviders(
      <ConnectScopesDisclosure scopes={['NotAScope', 'AlsoNotAScope']} />
    );
    expect(container.querySelector('[data-testid="connect-scopes-disclosure"]')).toBeNull();
  });

  test('separates SENSITIVE scopes into their own group, ahead of the rest', async () => {
    const { container } = await renderWithProviders(
      <ConnectScopesDisclosure scopes={['ModelsRead', 'BuzzRead']} />
    );
    const within = page.elementLocator(container);

    // `BuzzRead` is sensitive (money), `ModelsRead` is not. Asserting the SPLIT, not just
    // that both render — a component that dropped the grouping would still show both.
    await expect
      .element(within.getByTestId('connect-scopes-disclosure-sensitive-group'))
      .toBeInTheDocument();
    await expect
      .element(within.getByTestId('connect-scopes-disclosure-normal-group'))
      .toBeInTheDocument();

    const sensitive = container.querySelector(
      '[data-testid="connect-scopes-disclosure-sensitive-group"]'
    );
    expect(sensitive?.textContent).toContain('BuzzRead');
    expect(sensitive?.textContent).not.toContain('ModelsRead');
  });

  test('a lone non-sensitive scope renders without a sensitive group', async () => {
    const { container } = await renderWithProviders(
      <ConnectScopesDisclosure scopes={['ModelsRead']} />
    );
    expect(
      container.querySelector('[data-testid="connect-scopes-disclosure-sensitive-group"]')
    ).toBeNull();
    expect(container.textContent).toContain('ModelsRead');
  });

  test('NEVER renders developer-authored justification text', async () => {
    // Structural, not conventional: the component takes no justifications prop and the
    // shared row cannot render the text without children. This asserts the OUTCOME, so
    // it still fails if someone later threads a prop through.
    const { container } = await renderWithProviders(
      <ConnectScopesDisclosure scopes={['BuzzRead']} />
    );
    expect(container.textContent).not.toContain('Why:');
    expect(container.textContent).not.toContain('No justification provided');
  });

  /**
   * 🔴 THE PAIR THAT MAKES EITHER HALF MEAN ANYTHING. Asserting only the public heading
   * would pass a component that hardcoded it; asserting only the preview heading would
   * pass one that hardcoded THAT. Hardcoding either string reddens exactly one of these.
   */
  test('the PUBLIC posture does not tell the viewer the set is already approved', async () => {
    const { container } = await renderWithProviders(
      <ConnectScopesDisclosure scopes={['BuzzRead']} />
    );
    expect(container.textContent).toContain('Permissions this app may request');
    expect(container.textContent).not.toContain('Permissions requested in this submission');
  });

  test('under `preview` it says THIS SUBMISSION, because a moderator has not approved it yet', async () => {
    const { container } = await renderWithProviders(
      <ConnectScopesDisclosure scopes={['BuzzRead']} preview />
    );
    expect(container.textContent).toContain('Permissions requested in this submission');
    expect(container.textContent).not.toContain('Permissions this app may request');
  });
});
