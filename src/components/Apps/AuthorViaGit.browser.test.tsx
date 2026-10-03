import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
// Type-only namespace import (NOT `typeof import('...')`, which
// @typescript-eslint/consistent-type-imports rejects) so the spread below keeps the real
// module's type.
import type * as TrpcMod from '~/utils/trpc';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

/**
 * `AuthorViaGit` — the git-access panel, which had NO test of any kind.
 *
 * Written because this component's private `CopyableCode` was converted onto the shared
 * `CopyAffordance`, and converting untested code is how a refactor ships a regression nobody
 * sees. Two of its three claims are about behaviour the conversion CHANGED or FIXED, and the
 * third is about behaviour it must not have changed:
 *
 *  1. 🔴 THE TWO COPY CONTROLS HAVE DISTINCT ACCESSIBLE NAMES. They did not before — both
 *     were the bare string `"Copy"`, so a screen-reader user on this panel heard "Copy" and
 *     "Copy" with nothing to tell the token-bearing clone URL from the setup steps. That is
 *     precisely the drift `CopyableCommand`'s header names as the reason a shared component
 *     exists, sitting undetected in a fifth private copy of it.
 *  2. 🔴 THE CLIPBOARD GETS THE REAL TOKEN WHILE THE SCREEN SHOWS A MASKED ONE. This is the
 *     component's whole security posture — its header says the token "is never in the DOM on
 *     first paint" and that copy works regardless of the reveal toggle — and nothing asserted
 *     it. The conversion moved the `value`/`display` split onto `CopyAffordance`'s
 *     `value` + render-prop shape, so this is also the pin that the split survived.
 *  3. One press is one copy. The old private copy had NO handler on its icon and fired once
 *     by bubbling; the shared component has one, with `stopPropagation()`. Different
 *     mechanism, same count — which is the thing worth pinning.
 */

const CLONE_URL = 'https://civitai:gittoken123@git.example.test/author/my-app.git';
const INSTRUCTIONS = `git clone ${CLONE_URL}\ncd my-app\ngit push origin main`;

const mocks = vi.hoisted(() => ({
  repo: undefined as unknown,
  isLoading: false,
  isError: false,
  error: { message: 'nope' },
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  // 🔴 THE SHARED PROXY, NOT A HAND-ENUMERATED OBJECT. A literal `trpc` mock answers
  // `undefined` for every procedure nobody remembered, so the component throws during render
  // and the test fails on "Cannot find element with locator: …" — a fixture defect wearing a
  // component defect's error message. `test/trpcProxyStub.ts`'s header records four separate
  // times that cost this repo. The overridden procedure keeps its own spy, so nothing below
  // is weakened, and no assertion here reads a proxy DEFAULT (which that header forbids).
  trpc: makeTrpcProxy({
    'blocks.getMyAppRepo': {
      useQuery: () => ({
        data: mocks.repo,
        isLoading: mocks.isLoading,
        isError: mocks.isError,
        error: mocks.error,
      }),
    },
  }),
}));

const { AuthorViaGit } = await import('./AuthorViaGit');

const writeText = () => vi.mocked(navigator.clipboard.writeText);

/** Expand the panel — the query is deliberately lazy, so nothing renders until this. */
async function openPanel() {
  await renderWithProviders(<AuthorViaGit appBlockId="app-1" />);
  await page.getByRole('button', { name: 'Author via git' }).click();
}

beforeEach(() => {
  writeText().mockClear();
  window.getSelection()?.removeAllRanges();
  mocks.isLoading = false;
  mocks.isError = false;
  mocks.repo = {
    notYetAvailable: false,
    slug: 'my-app',
    httpUrl: 'https://git.example.test/author/my-app',
    cloneUrl: CLONE_URL,
    forgejoUsername: 'author',
    instructions: INSTRUCTIONS,
    firstVersionIsZip: false,
  };
});

describe('AuthorViaGit — the git access panel', () => {
  test('🔴 the two copy controls have DISTINCT accessible names', async () => {
    await openPanel();

    await expect.element(page.getByRole('button', { name: 'Copy clone URL' })).toBeInTheDocument();
    await expect
      .element(page.getByRole('button', { name: 'Copy setup steps' }))
      .toBeInTheDocument();
    // The defect this replaced: two controls both named exactly "Copy".
    expect(
      page.getByRole('button', { name: 'Copy', exact: true }).elements(),
      'a copy control is still using the ambiguous bare "Copy" name'
    ).toHaveLength(0);
  });

  test('🔴 the token is MASKED on screen and REAL on the clipboard', async () => {
    await openPanel();

    // On screen: the credential is masked on first paint, before any reveal.
    const panelText = document.body.textContent ?? '';
    expect(panelText, 'the push token is in the DOM on first paint').not.toContain('gittoken123');

    // On the clipboard: the real, unmasked URL — copy works regardless of the toggle.
    await page.getByRole('button', { name: 'Copy clone URL' }).click();
    expect(writeText()).toHaveBeenCalledWith(CLONE_URL);
  });

  /**
   * 🔴 THE BLOCK IS NOT A CLICK TARGET, AND HERE THAT IS A CREDENTIAL QUESTION. Both bodies
   * are multi-line text a reader selects fragments of, and the clone URL embeds a live push
   * token. With a body-wide click target, the `click` that ends a drag-select put that
   * credential on the system clipboard from a gesture that was not a copy. This is a
   * deliberate behaviour change from the private copy this component replaced.
   */
  test('🔴 clicking the code block does NOT copy the credential', async () => {
    await openPanel();

    await page
      .getByText(/git\.example\.test/)
      .first()
      .click();
    expect(writeText(), 'clicking the block put the token on the clipboard').not.toHaveBeenCalled();

    // POSITIVE CONTROL: the control on the very same block does copy.
    await page.getByRole('button', { name: 'Copy clone URL' }).click();
    expect(writeText()).toHaveBeenCalledWith(CLONE_URL);
  });

  test('🔴 the setup steps copy their REAL text too, not the masked display', async () => {
    await openPanel();
    await page.getByRole('button', { name: 'Copy setup steps' }).click();
    expect(writeText()).toHaveBeenCalledWith(INSTRUCTIONS);
  });

  test('one press is one copy', async () => {
    await openPanel();
    await page.getByRole('button', { name: 'Copy clone URL' }).click();
    expect(writeText()).toHaveBeenCalledTimes(1);
  });

  test('POSITIVE CONTROL: revealing the token puts the real URL on screen', async () => {
    // Without this, the masking assertion above is satisfied by a panel that never renders
    // the clone URL at all — including one where the query silently returned nothing.
    await openPanel();
    await page.getByRole('button', { name: 'Reveal token' }).click();
    // `.first()` because the token legitimately appears TWICE once revealed — the clone URL
    // and the instructions both embed it, and both are masked by the same toggle. A bare
    // `getByText` is a strict-mode violation here, which is itself the control working: the
    // masking assertion above is denying two occurrences, not one.
    await expect
      .element(page.getByText('gittoken123', { exact: false }).first())
      .toBeInTheDocument();
    expect(page.getByText('gittoken123', { exact: false }).elements()).toHaveLength(2);
  });

  test('the panel does not render until the affordance is expanded', async () => {
    // The query lazily PROVISIONS a scoped git identity as a side effect, so it must stay
    // user-initiated; a copy control appearing before the click would mean it had run.
    await renderWithProviders(<AuthorViaGit appBlockId="app-1" />);
    await expect.element(page.getByRole('button', { name: 'Author via git' })).toBeInTheDocument();
    expect(page.getByRole('button', { name: 'Copy clone URL' }).elements()).toHaveLength(0);
  });
});
