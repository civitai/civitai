import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { SubmitModeSelector, type SubmitMode } from '~/components/Apps/SubmitModeSelector';
import { APP_BLOCK_OAUTH_CLIENT_ID_PREFIX } from '~/shared/constants/block-scope.constants';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
// Type-only: gives the `importOriginal` spread below the real module's type
// without an `import()` type annotation (banned by consistent-type-imports).
import type * as TrpcModule from '~/utils/trpc';

/**
 * W13 — /apps/submit type-picker cards.
 *
 * Covers the two cards + their mode ids (unchanged), the aligned "Standalone"
 * wording, and the OAUTH PREREQUISITE now surfaced HERE rather than at wizard step 2.
 *
 * ## 🔴 THE DEFECT THESE TESTS WOULD HAVE CAUGHT
 *
 * Measured on production: a developer picked the standalone card, typed a URL, hit
 * Next (firing a server-side metadata fetch), landed on step 2 — and only there read
 * "You have no eligible OAuth apps", with `Next` disabled. A dead-end reachable only
 * after doing work. The prerequisite is a property of the CHOICE, so it is asserted
 * at the choice.
 *
 * ## 🔴 AND THE ONE A NAIVE FIX WOULD HAVE INTRODUCED
 *
 * "Show the notice when the client list is empty" is wrong, because an in-flight
 * query ALSO has an empty list. That would tell a developer who owns three OAuth
 * clients that they own none, every time, for the duration of the fetch. The loading
 * case below is a first-class test, not a footnote.
 */

const OWN_CLIENT = { id: 'oauth-client-1', name: 'My OAuth App', allowedScopes: 4 };

const mocks = vi.hoisted(() => ({
  // `data: undefined` is the LOADING/unsettled shape — the hook branches on whether
  // the query settled with data, so `undefined` here is what "we don't know yet" is.
  clients: { data: undefined as unknown } as { data: unknown },
}));

// Only the `trpc` client itself is overridden — every other `~/utils/trpc` export is
// kept real via importOriginal. A wholesale factory silently breaks this whole FILE
// (0 tests collected, no failing assertion) the day the module gains an export some
// other file in this test's graph imports. See local-rules/no-wholesale-module-mock.
vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof TrpcModule>();
  return {
    ...actual,
    trpc: {
      oauthClient: {
        getAll: { useQuery: () => mocks.clients },
      },
    },
  };
});

beforeEach(() => {
  mocks.clients = { data: undefined };
});

describe('SubmitModeSelector', () => {
  test('renders both type cards, no separate Connect card', async () => {
    mocks.clients = { data: [OWN_CLIENT] };
    renderWithProviders(<SubmitModeSelector onSelect={vi.fn()} />);
    await expect.element(page.getByTestId('apps-submit-mode-card-app')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-submit-mode-card-external')).toBeInTheDocument();
    await expect.element(page.getByText('App', { exact: true })).toBeInTheDocument();
    // The merged model has no standalone connect card.
    expect(document.querySelector('[data-testid="apps-submit-mode-card-connect"]')).toBeNull();
  });

  /**
   * 🔴 THE WHOLE NORMALISED STRING, not a keyword. The measured defect WAS a wording
   * disagreement inside this one card — its title said "external app" while its own
   * body said "standalone app" — so a guard that matched the word "standalone"
   * anywhere would have passed on the broken render. Both strings are pinned in full.
   */
  test('both halves of the standalone card say "Standalone", in full', async () => {
    mocks.clients = { data: [OWN_CLIENT] };
    renderWithProviders(<SubmitModeSelector onSelect={vi.fn()} />);
    await expect
      .element(page.getByText('List a Standalone app (connect your OAuth app)', { exact: true }))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          'List a Standalone app hosted elsewhere by linking your registered OAuth app so users can grant it access. Disclose the scopes your app requests and why, add an optional homepage link — a moderator reviews before it appears.',
          { exact: true }
        )
      )
      .toBeInTheDocument();
  });

  test('picking "App" calls onSelect("block") — code id unchanged', async () => {
    mocks.clients = { data: [OWN_CLIENT] };
    const onSelect = vi.fn<(mode: SubmitMode) => void>();
    renderWithProviders(<SubmitModeSelector onSelect={onSelect} />);
    await page.getByTestId('apps-submit-mode-card-app').click();
    expect(onSelect).toHaveBeenCalledWith('block');
  });

  test('picking the standalone card calls onSelect("external") — code id unchanged', async () => {
    mocks.clients = { data: [OWN_CLIENT] };
    const onSelect = vi.fn<(mode: SubmitMode) => void>();
    renderWithProviders(<SubmitModeSelector onSelect={onSelect} />);
    await page.getByTestId('apps-submit-mode-card-external').click();
    expect(onSelect).toHaveBeenCalledWith('external');
  });
});

describe('SubmitModeSelector — the OAuth prerequisite is surfaced at the CHOICE', () => {
  test('🔴 zero eligible clients: the card states the requirement UP FRONT', async () => {
    mocks.clients = { data: [] };
    renderWithProviders(<SubmitModeSelector onSelect={vi.fn()} />);

    const notice = page.getByTestId('apps-submit-mode-external-prerequisite');
    await expect.element(notice).toBeInTheDocument();
    // 🔴 The WHOLE sentence, typed out — NOT compared against the component's own
    // exported constant, which would make the assertion true for whatever the
    // component happens to say. A reworded explanation is a deliberate edit that
    // fails here first.
    expect(notice.element().textContent).toContain(
      'Listing a standalone app requires an OAuth app — that is what lets people sign in to your app with their Civitai account. You do not have one yet.'
    );
  });

  test('🔴 the notice ROUTES to account settings, in a new tab', async () => {
    mocks.clients = { data: [] };
    renderWithProviders(<SubmitModeSelector onSelect={vi.fn()} />);
    const link = page.getByTestId('apps-submit-mode-external-prerequisite-link');
    await expect.element(link).toBeInTheDocument();
    const el = link.element();
    expect(el.getAttribute('href')).toBe('/user/account');
    // A new tab so an in-progress choice / wizard state is not lost.
    expect(el.getAttribute('target')).toBe('_blank');
    expect(el.getAttribute('rel')).toContain('noopener');
    expect(el.getAttribute('rel')).toContain('noreferrer');
  });

  /**
   * 🔴 THE CARD IS NOT DISABLED — asserted, because "just disable it" is the obvious
   * alternative fix and it is the wrong one: the notice is driven by a client-side
   * read that can be stale or errored, a disabled control leaves the tab order (so a
   * keyboard user gets the block without the reason), and step 2 already gates
   * submission. The card informs and offers the fix; it does not refuse.
   */
  test('🔴 the card stays CLICKABLE with no eligible clients (informs, does not refuse)', async () => {
    mocks.clients = { data: [] };
    const onSelect = vi.fn<(mode: SubmitMode) => void>();
    renderWithProviders(<SubmitModeSelector onSelect={onSelect} />);
    await expect
      .element(page.getByTestId('apps-submit-mode-external-prerequisite'))
      .toBeInTheDocument();

    const card = page.getByTestId('apps-submit-mode-card-external');
    expect(card.element().hasAttribute('disabled')).toBe(false);
    await card.click();
    expect(onSelect).toHaveBeenCalledWith('external');
  });

  /**
   * 🔴 A PENDING FETCH MUST NOT READ AS "YOU HAVE NONE".
   *
   * SETTLE-THEN-ASSERT: `.not.toBeInTheDocument()` resolves on the FIRST empty
   * observation, so asserted straight after `render()` it passes against a DOM that
   * has not mounted yet — a vacuous green in ~6ms. Awaiting the card first proves the
   * component rendered, so the absence below is a real absence in a real tree. The
   * zero-clients test above is the positive control that this assertion CAN observe
   * the notice when it exists.
   */
  test('🔴 LOADING does NOT render as "you have no OAuth apps"', async () => {
    mocks.clients = { data: undefined }; // in flight — not settled, not empty
    renderWithProviders(<SubmitModeSelector onSelect={vi.fn()} />);

    // Settle: the component has really rendered its card.
    await expect.element(page.getByTestId('apps-submit-mode-card-external')).toBeInTheDocument();
    await expect
      .element(page.getByTestId('apps-submit-mode-external-prerequisite'))
      .not.toBeInTheDocument();
  });

  /** THE NEGATIVE CONTROL: a developer who HAS a client is told nothing. */
  test('🔴 with an eligible client, NO prerequisite notice is shown', async () => {
    mocks.clients = { data: [OWN_CLIENT] };
    renderWithProviders(<SubmitModeSelector onSelect={vi.fn()} />);

    await expect.element(page.getByTestId('apps-submit-mode-card-external')).toBeInTheDocument();
    await expect
      .element(page.getByTestId('apps-submit-mode-external-prerequisite'))
      .not.toBeInTheDocument();
  });

  /**
   * An auto-provisioned App-Block client is managed by the App Blocks flow and is
   * never a hand-authored listing target — owning only those is owning NONE, and the
   * prerequisite must fire. This is the eligibility PREDICATE, exercised through the
   * UI that depends on it.
   */
  test('🔴 owning ONLY an App-Block client counts as having none', async () => {
    mocks.clients = {
      data: [{ id: `${APP_BLOCK_OAUTH_CLIENT_ID_PREFIX}abc`, name: 'Block', allowedScopes: 4 }],
    };
    renderWithProviders(<SubmitModeSelector onSelect={vi.fn()} />);
    await expect
      .element(page.getByTestId('apps-submit-mode-external-prerequisite'))
      .toBeInTheDocument();
  });
});
