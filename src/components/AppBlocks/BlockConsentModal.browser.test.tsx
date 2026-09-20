import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * BlockConsentModal — the lazy-consent surface a logged-in viewer sees when a
 * block requests consent-gated scopes it doesn't yet carry (REQUEST_CONSENT).
 * This suite pins that SENSITIVE requested scopes are visually emphasised for
 * the END USER (the reusable "Sensitive" indicator) while normal scopes are not.
 *
 * The modal reads its open/close props from `useDialogContext` and grants via
 * `trpc.blocks.grantScopes` — both stubbed so the render stays network-free.
 */

vi.mock('~/components/Dialog/DialogProvider', () => ({
  useDialogContext: () => ({ opened: true, onClose: vi.fn(), zIndex: 200 }),
}));

// Hoisted so the tests can read the exact payload the Allow button submits — the budget
// half of this component is entirely about WHAT IS SENT, and a render-only assertion
// cannot see the difference between "omit the key" and "send null", which is the one
// distinction the server acts on.
const { mutate, feeQuery } = vi.hoisted(() => ({
  mutate: vi.fn(),
  // 🔴 A WHOLESALE MODULE MOCK GOES STALE SILENTLY, AND THIS ONE ALREADY DID.
  // The component now also calls `trpc.blocks.getAuthorFeeDisclosure.useQuery`;
  // a mock that does not export it throws `useQuery is not a function` at render
  // — i.e. the component under test cannot mount at all, which is a failure that
  // looks like a component bug rather than a stale fixture. Driven per-test via
  // `feeQuery.data`; the DEFAULT is the as-merged posture (fee dark → no data →
  // nothing rendered), so every pre-existing assertion in this file is unchanged.
  feeQuery: { data: undefined as unknown },
}));

vi.mock('~/utils/trpc', () => ({
  trpc: {
    blocks: {
      grantScopes: {
        useMutation: () => ({ mutate, isPending: false }),
      },
      getAuthorFeeDisclosure: {
        useQuery: () => ({ data: feeQuery.data }),
      },
    },
  },
}));

const { default: BlockConsentModal } = await import('./BlockConsentModal');

const SPEND = 'ai:write:budgeted';

describe('BlockConsentModal — sensitive scope emphasis for the end user', () => {
  test('a sensitive requested scope shows the "Sensitive" indicator; a normal one does not', async () => {
    renderWithProviders(
      <BlockConsentModal
        appBlockId="app-1"
        blockName="Tip Jar"
        // one sensitive (spends Buzz) + one normal (reads username).
        missingScopes={['social:tip:self', 'user:read:self']}
        onGranted={vi.fn()}
      />
    );
    // Friendly descriptions of both requested scopes render.
    await expect.element(page.getByText('Post tips on behalf of the viewer')).toBeInTheDocument();
    await expect
      .element(page.getByText("Read the viewer's username and account status"))
      .toBeInTheDocument();
    // Exactly ONE sensitive badge — for the Buzz-spending scope only.
    expect(page.getByTestId('sensitive-scope-badge').elements()).toHaveLength(1);
    // The Allow action is present.
    await expect.element(page.getByRole('button', { name: 'Allow' })).toBeInTheDocument();
  });

  test('renders no sensitive indicator when every requested scope is normal', async () => {
    renderWithProviders(
      <BlockConsentModal
        appBlockId="app-2"
        blockName="Model Viewer"
        missingScopes={['models:read:self', 'user:read:self']}
        onGranted={vi.fn()}
      />
    );
    await expect
      .element(page.getByText('Read the model on the page where the block is mounted'))
      .toBeInTheDocument();
    expect(page.getByTestId('sensitive-scope-badge').elements()).toHaveLength(0);
  });
});

/**
 * The per-app SPEND LIMIT the viewer sets at consent time.
 *
 * The control is shown ONLY when `ai:write:budgeted` is among the scopes being
 * consented to — it is the only scope that can spend anything, so a limit beside "read
 * your username" would be noise.
 *
 * 🔴 THE PAYLOAD ASSERTIONS ARE THE POINT, NOT THE RENDER. `recordScopeGrant`
 * distinguishes three states: a number (set), an explicit `null` (clear), and an OMITTED
 * key (leave alone). Only the last keeps a re-consent for an unrelated scope from wiping
 * a limit the user set earlier — so "the toggle is off" must send NO key, not `null`.
 */
describe('BlockConsentModal — per-app spend limit', () => {
  // INVARIANT GUARD — green at origin/main AND at HEAD, and VACUOUSLY at base: there is
  // no limit control there for it to fail to find. It carries information only at HEAD,
  // where the control exists and its absence here is a real branch. Not regression
  // coverage.
  test('the limit control is absent when no spend scope is being consented to', async () => {
    renderWithProviders(
      <BlockConsentModal
        appBlockId="app-3"
        blockName="Model Viewer"
        missingScopes={['models:read:self', 'user:read:self']}
        onGranted={vi.fn()}
      />
    );
    await expect.element(page.getByRole('button', { name: 'Allow' })).toBeInTheDocument();
    expect(page.getByTestId('block-consent-budget').elements()).toHaveLength(0);
  });

  test('the limit control appears when the spend scope is being consented to', async () => {
    renderWithProviders(
      <BlockConsentModal
        appBlockId="app-4"
        blockName="Generator"
        missingScopes={[SPEND]}
        onGranted={vi.fn()}
      />
    );
    await expect.element(page.getByTestId('block-consent-budget-toggle')).toBeInTheDocument();
    // OFF by default, so the input is not yet shown.
    expect(page.getByTestId('block-consent-budget-input').elements()).toHaveLength(0);
  });

  // INVARIANT GUARD — green at both, and vacuously at base for the same reason: the base
  // component has no budget to send either way. What it pins at HEAD is the distinction
  // the SERVER acts on — omitted (leave a stored budget alone) vs explicit null (clear
  // it) — so an off toggle must send NO key.
  test('with the limit OFF, Allow OMITS buzzBudgetPerDay entirely (it does not send null)', async () => {
    mutate.mockClear();
    renderWithProviders(
      <BlockConsentModal
        appBlockId="app-5"
        blockName="Generator"
        missingScopes={[SPEND]}
        onGranted={vi.fn()}
      />
    );
    await page.getByRole('button', { name: 'Allow' }).click();
    expect(mutate).toHaveBeenCalledTimes(1);
    const payload = mutate.mock.calls[0][0];
    expect(payload).toEqual({ appBlockId: 'app-5', scopes: [SPEND] });
    // Explicitly: the KEY is absent. `toEqual` above would also pass for an explicit
    // `undefined`, and the server tests the key's presence.
    expect(Object.hasOwn(payload, 'buzzBudgetPerDay')).toBe(false);
  });

  test('with the limit ON, Allow sends the entered budget', async () => {
    mutate.mockClear();
    renderWithProviders(
      <BlockConsentModal
        appBlockId="app-6"
        blockName="Generator"
        missingScopes={[SPEND]}
        onGranted={vi.fn()}
      />
    );
    await page.getByTestId('block-consent-budget-toggle').click();
    await expect.element(page.getByTestId('block-consent-budget-input')).toBeInTheDocument();
    await page.getByRole('button', { name: 'Allow' }).click();
    expect(mutate).toHaveBeenCalledTimes(1);
    // The pre-filled suggestion is deliberately far below the platform ceiling: the
    // default should be a limit, not a formality.
    expect(mutate.mock.calls[0][0]).toEqual({
      appBlockId: 'app-6',
      scopes: [SPEND],
      buzzBudgetPerDay: 1000,
    });
  });

  // ── OFF-STATE COPY. 🔴 PINNED AS A WHOLE NORMALISED STRING, not by keyword, because
  // the defect this replaces was a keyword-passing sentence: "No limit set — this app
  // spends under your account's overall daily cap." That was FALSE whenever a limit was
  // already stored (this modal never reads the stored value; an off toggle OMITS the
  // field, meaning "leave it alone", not "there is none"), so it told a user with a live
  // limit that nothing bounded the app. A word-level guard would walk straight past a
  // reworded relapse; the whole string will not.
  test('the OFF-state copy does not claim there is no limit', async () => {
    renderWithProviders(
      <BlockConsentModal
        appBlockId="app-8"
        blockName="Generator"
        missingScopes={[SPEND]}
        onGranted={vi.fn()}
      />
    );
    const el = page.getByTestId('block-consent-budget-off');
    await expect.element(el).toBeInTheDocument();
    const text = ((await el.element().textContent) ?? '').replace(/\s+/g, ' ').trim();
    expect(text).toBe(
      'Any limit you have already set for this app stays as it is. Manage it under ' +
        'Apps \u2192 Permissions. This app always spends under your account\u2019s overall ' +
        'daily cap.'
    );
  });

  // A very low limit is storable (the floor is 1) and enforced exactly as given, so the
  // dialog has to say what it does at the moment it is chosen — otherwise the app just
  // looks broken afterwards, with no explanation and (before the editor existed) no way
  // back. 90 is the lowest per-engine post-paid ceiling any registered recipe declares.
  test('warns when the entered limit is too low to fund a generation', async () => {
    renderWithProviders(
      <BlockConsentModal
        appBlockId="app-9"
        blockName="Generator"
        missingScopes={[SPEND]}
        onGranted={vi.fn()}
      />
    );
    await page.getByTestId('block-consent-budget-toggle').click();
    const input = page.getByTestId('block-consent-budget-input');
    // 1000 (the default) is comfortably fundable → no warning.
    expect(page.getByTestId('block-consent-budget-low-warning').elements()).toHaveLength(0);
    await input.clear();
    await input.fill('5');
    await expect.element(page.getByTestId('block-consent-budget-low-warning')).toBeInTheDocument();
    // 🔴 PINNED AS A WHOLE NORMALISED STRING, and DELIBERATELY AS A LITERAL — it must NOT
    // read BLOCK_CONSENT_BUDGET_LOW_WARNING_BODY. The components share that constant so they
    // cannot drift from each other; if this expectation read it too, the assertion would be
    // tautological and a reworded relapse would pass silently. FIVE wordings of this sentence
    // shipped false, every one keyword-clean, which is what a whole-string literal catches.
    // The rules the wording must satisfy are in that constant's docblock.
    {
      const el = page.getByTestId('block-consent-budget-low-warning');
      const text = ((await el.element().textContent) ?? '').replace(/\s+/g, ' ').trim();
      expect(text).toBe(
        '5 Buzz/day is a low limit. Each generation reserves Buzz up front, and is refused if that reservation exceeds your remaining limit for the day — so a low limit can make an app look broken. You can change it later under Apps → Permissions.'
      );
    }
    // …and it goes away again above the threshold, so the warning tracks the VALUE and
    // is not just "shown once the field was touched".
    await input.clear();
    await input.fill('500');
    await expect
      .element(page.getByTestId('block-consent-budget-low-warning'))
      .not.toBeInTheDocument();
  });

  test('an out-of-range budget blocks Allow rather than sending a value the server will refuse', async () => {
    mutate.mockClear();
    renderWithProviders(
      <BlockConsentModal
        appBlockId="app-7"
        blockName="Generator"
        missingScopes={[SPEND]}
        onGranted={vi.fn()}
      />
    );
    await page.getByTestId('block-consent-budget-toggle').click();
    const input = page.getByTestId('block-consent-budget-input');
    await input.clear();
    await input.fill('999999');
    await expect.element(page.getByRole('button', { name: 'Allow' })).toBeDisabled();
    expect(mutate).not.toHaveBeenCalled();
  });
});

/**
 * THE AUTHOR-FEE NOTICE — the platform-owned half of the price disclosure.
 *
 * WHY IT IS HERE AND NOT ONLY ON THE RUN PRICE. The two estimate arms now add
 * the fee to the total they return, so the number an app shows before a run is
 * the number the viewer is debited. That makes the price honest and leaves the
 * fee INVISIBLE AS A FEE — the viewer sees a bigger number and cannot tell the
 * app takes a cut. This notice is the only surface that says so, and it is one
 * the platform renders rather than the app's own bundle.
 *
 * NEW-FEATURE coverage, stated honestly: the notice did not exist at
 * `origin/main`. What it pins is the GATING — it must not appear when the fee is
 * dark, and must not appear for a consent that cannot lead to a charge.
 */
describe('BlockConsentModal — per-generation author fee notice', () => {
  const LIVE_FEE = { disclose: true, flatBuzz: 1, pctBasisPoints: 500, quotesFigureSafely: true };

  // 🔴 RESET, NOT INHERIT. `feeQuery` is hoisted and module-scoped, so without
  // this the fee state leaks into whatever runs next — green today only because
  // file order puts the pre-existing describes first. Under `--sequence.shuffle`
  // a pre-existing test would render the notice and fail for a reason that has
  // nothing to do with it.
  beforeEach(() => {
    feeQuery.data = undefined;
  });

  function renderConsent(scopes: string[] = [SPEND]) {
    renderWithProviders(
      <BlockConsentModal
        appBlockId="app-fee"
        blockName="Tip Jar"
        missingScopes={scopes}
        onGranted={vi.fn()}
      />
    );
  }

  test('states the RULE, with figures served from the fee config', async () => {
    feeQuery.data = LIVE_FEE;
    renderConsent();
    const notice = page.getByTestId('block-consent-author-fee');
    await expect.element(notice).toBeInTheDocument();
    await expect.element(notice).toHaveTextContent('at most 1 Buzz or 5% of that cost');
    // 🔴 THE RULE, NOT A BARE PERCENTAGE. The fee is max(flat, pct × base), so a
    // lone "5%" is WRONG on a cheap generation — at a base of 10 the 5% leg
    // floors to 0 and the viewer pays the 1 ⚡ flat leg instead.
    await expect.element(notice).toHaveTextContent('whichever is larger');
    // 🔴 POSSIBILITY, NOT ASSERTION. The disclosure is platform-wide and takes no
    // app id, so it cannot know whether THIS app ever charges — a customComfy-only
    // or pass-through-only app never does, nor does a self-dealing author.
    await expect.element(notice).toHaveTextContent('can include a developer fee');
    await expect.element(notice).toHaveTextContent('Not every generation is charged one.');
  });

  test('is honest about what the author receives', async () => {
    // Both money hops preserve the Buzz account type, so a viewer spending
    // non-withdrawable Buzz funds a non-withdrawable credit.
    feeQuery.data = LIVE_FEE;
    renderConsent();
    const notice = page.getByTestId('block-consent-author-fee');
    await expect.element(notice).toHaveTextContent('non-withdrawable');
    // And honest about what the PLATFORM controls: the price it quotes the app,
    // not what the app's own bundle chooses to render.
    await expect.element(notice).toHaveTextContent('adds the fee to the run price it quotes');
  });

  test('🔴 renders NOTHING while the fee is dark (the as-merged posture)', async () => {
    feeQuery.data = { disclose: false };
    renderConsent();
    // The rest of the consent screen still renders — this asserts the notice is
    // absent, not that the modal failed to mount.
    await expect.element(page.getByRole('button', { name: 'Allow' })).toBeInTheDocument();
    expect(page.getByTestId('block-consent-author-fee').elements()).toHaveLength(0);
  });

  test('🔴 renders NOTHING when the query has not answered', async () => {
    // Loading, errored, or disabled. An absent answer must never fall back to
    // asserting a fee — a consent screen that promises a charge the platform
    // does not take is the same defect as one that hides a charge it does.
    feeQuery.data = undefined;
    renderConsent();
    await expect.element(page.getByRole('button', { name: 'Allow' })).toBeInTheDocument();
    expect(page.getByTestId('block-consent-author-fee').elements()).toHaveLength(0);
  });

  test('🔴 renders NOTHING for a consent that cannot lead to a charge', async () => {
    // The fee exists only on generation paths, which need the spend scope. A
    // charge notice on a profile-read consent would describe a charge this app
    // cannot make.
    feeQuery.data = LIVE_FEE;
    renderConsent(['user:read:self']);
    await expect.element(page.getByRole('button', { name: 'Allow' })).toBeInTheDocument();
    expect(page.getByTestId('block-consent-author-fee').elements()).toHaveLength(0);
  });

  test('drops the figure when the config is no longer describable by one', async () => {
    // Unreachable at today's platform config, and that is the point: a charging
    // override must change WHICH sentence renders rather than silently making a
    // rendered number wrong.
    feeQuery.data = { ...LIVE_FEE, quotesFigureSafely: false };
    renderConsent();
    const notice = page.getByTestId('block-consent-author-fee');
    await expect.element(notice).toHaveTextContent('depends on the generation type');
    await expect.element(notice).not.toHaveTextContent('at most 1 Buzz');
  });

  test('the notice precedes the daily-limit control', async () => {
    // A price the viewer is agreeing to must be readable before the cap they
    // choose; reading the cap first invites setting a limit without knowing what
    // a run costs.
    feeQuery.data = LIVE_FEE;
    renderConsent();
    // Settle the render through the retrying matcher FIRST — `.elements()` is a
    // synchronous snapshot and reads an empty list if it runs before the mount.
    await expect.element(page.getByTestId('block-consent-author-fee')).toBeInTheDocument();
    const notice = page.getByTestId('block-consent-author-fee').elements()[0];
    const budget = page.getByTestId('block-consent-budget').elements()[0];
    expect(notice).toBeDefined();
    expect(budget).toBeDefined();
    expect(notice.compareDocumentPosition(budget) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
