import { afterEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { CliSubmitCta } from '~/components/Apps/CliSubmitCta';
import {
  CIVITAI_CLI_GITHUB_URL,
  CIVITAI_CLI_RELEASES_URL,
  CLI_CREATE_COMMAND,
  CLI_CREATE_SAMPLE_COMMAND,
  CLI_INSTALL_BREW,
  CLI_INSTALL_GO,
  CLI_INSTALL_NPM,
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

/**
 * Captured BEFORE any `vi.useFakeTimers()` call so the helpers below can still
 * yield a REAL macrotask while virtual time stands still — `setTimeout` is faked
 * inside the copy tests, so the obvious `new Promise((r) => setTimeout(r, 0))`
 * would never resolve.
 */
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

/**
 * 🔴 The virtual clock must never escape a test. A `finally` inside the test body
 * does NOT run when a test TIMES OUT (the awaited promise never settles) — and a
 * timer test is exactly where that happens — which would leave every subsequent
 * test in this file on a frozen clock. Same hook, same reason as
 * `src/components/Apps/AppListingsMarketplaceBody.browser.test.tsx` (civitai#3654)
 * and `src/components/AppBlocks/PageBlockHostAutoRetry.browser.test.tsx`.
 *
 * Vitest runs `afterEach` hooks in reverse registration order, so this runs
 * BEFORE the setup file's `await cleanup()` — the unmount never sees a frozen
 * clock either.
 */
afterEach(() => {
  vi.useRealTimers();
});

/**
 * Install the virtual clock, restricted to the timer functions.
 *
 * `Date`, `performance`, `requestAnimationFrame`, `queueMicrotask` and
 * `MessageChannel` stay REAL, so React's scheduler, Mantine and the Playwright
 * driver behave exactly as they do under real timers — the copy tests drive the
 * button through the real driver (`.click()` / `userEvent.keyboard`) while the
 * clock is frozen. The only thing that becomes virtual is how long a
 * `setTimeout` takes to fire, which is precisely the copied-state reset below.
 *
 * `Date` staying real is load-bearing for `settleCopy()`, which budgets in REAL
 * time.
 */
function useVirtualClock() {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
}

/**
 * Move virtual time forward by exactly `ms`, then let React commit whatever the
 * fired timers scheduled. `advance(0)` is therefore also the "flush pending
 * renders + effects" primitive: it fires nothing, it only drains the queues.
 *
 * The real-macrotask yield is load-bearing — advancing virtual time alone gives
 * the page only microtasks, so a passive effect scheduled on React's
 * MessageChannel would not have run by the time the next assertion reads the DOM.
 */
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 5; i++) {
    await vi.advanceTimersByTimeAsync(0);
    await new Promise((resolve) => realSetTimeout(resolve, 0));
  }
}

/**
 * Mantine's `CopyButton` resets `copied` back to `false` after this many ms —
 * `defaultProps = { timeout: 1e3 }` in
 * `@mantine/core/esm/components/CopyButton/CopyButton.mjs`, armed by
 * `useClipboard`'s `window.setTimeout(() => setCopied(false), timeout)`.
 * `CliSubmitCta` does not override it.
 *
 * If a Mantine upgrade moves this default, the boundary assertions below go red
 * and the number gets updated as a deliberate, reviewed edit — which is the
 * point of pinning it rather than sleeping past it.
 */
const COPIED_RESET_MS = 1000;

/** How many "Copied" labels are on screen, read SYNCHRONOUSLY (no retry loop). */
function copiedLabels() {
  return page.getByText('Copied').elements().length;
}

/**
 * Give the copy a bounded budget of REAL time to land, then return.
 *
 * The copy itself is genuinely async (`navigator.clipboard.writeText(...).then(...)`,
 * stubbed to a resolving `vi.fn()` in `test/component-setup.tsx`), so *something*
 * has to wait for it. Waiting is safe here precisely because the clock is frozen:
 * once "Copied" appears it STAYS, so this is the legitimate "wait for a stable
 * end-state" pattern, not a race. The budget matches the setup file's
 * `DEFAULT_WAITFOR_TIMEOUT_MS`.
 *
 * It deliberately does NOT throw — the CALLER asserts, so a component that stops
 * copying goes red at the test's own `expect`, naming the real guard.
 */
async function settleCopy() {
  const deadline = Date.now() + 10_000; // `Date` is not faked — this is real time.
  do {
    await advance(0);
    if (copiedLabels() > 0) return;
    await new Promise((resolve) => realSetTimeout(resolve, 10));
  } while (Date.now() < deadline);
}

/**
 * 🔴 THE TWO FLOW-A DEFECTS THIS FILE NOW PINS.
 *
 * (1) The panel was headed "Recommended: use the Civitai CLI". "Recommended" implies
 *     an alternative, and this page offers none — the manual ZIP flow does not exist
 *     here. Advertising a choice that is not on offer sends the reader looking for
 *     the other option. The heading is asserted BOTH ways: the honest text is present
 *     AND the retired promise is absent, because "the new string renders" would also
 *     pass if the old one still rendered beside it.
 *
 * (2) The only install path shown was `brew`, which stops a Windows developer at
 *     step 1 of 3. Every route asserted below was verified against the CLI's own
 *     release artefacts (see the provenance block in `cliCommands.ts`) — the tests
 *     pin what the page CLAIMS, and the provenance is what makes the claim true.
 */
describe('CliSubmitCta (CLI-first submit primary CTA)', () => {
  test('🔴 the heading no longer promises an alternative that does not exist', async () => {
    renderWithProviders(<CliSubmitCta />);
    // Settle on the honest heading first, so the absence assertion below runs against
    // a mounted tree rather than an empty one.
    await expect
      .element(page.getByText('Use the Civitai CLI', { exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText('Recommended: use the Civitai CLI'))
      .not.toBeInTheDocument();
    // The word itself is gone from the panel, not merely moved out of the heading.
    await expect.element(page.getByText(/Recommended/)).not.toBeInTheDocument();
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

  /**
   * 🔴 THE PLATFORM-COVERAGE GUARD. The literal one-liners are pinned, NOT derived
   * from the constants they render — `expect(rendered).toBe(CLI_INSTALL_NPM)` would
   * pass for any value the constant happened to hold, including a command that does
   * not exist.
   */
  test('🔴 every platform has an install route (npm covers Windows)', async () => {
    renderWithProviders(<CliSubmitCta />);
    await expect.element(page.getByText('$ npm install -g @civitai/cli')).toBeInTheDocument();
    await expect.element(page.getByText('$ brew install civitai/tap/civitai')).toBeInTheDocument();
    await expect
      .element(page.getByText('$ go install github.com/civitai/cli/cmd/civitai@latest'))
      .toBeInTheDocument();

    // Each route says WHO it is for, so a reader can pick without guessing.
    await expect
      .element(page.getByText('Windows, macOS or Linux (needs Node):', { exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText('macOS or Linux, with Homebrew:', { exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText('From source (Go 1.25+):', { exact: true }))
      .toBeInTheDocument();

    // The no-toolchain route, and it names Windows explicitly.
    const binary = page.getByTestId('apps-cli-install-binary');
    await expect.element(binary).toBeInTheDocument();
    expect(binary.element().textContent).toContain('Windows');
    const releases = page.getByRole('link', { name: 'the CLI releases page' });
    await expect.element(releases).toBeInTheDocument();
    expect(releases.element().getAttribute('href')).toBe('https://github.com/civitai/cli/releases');
  });

  test('the install commands are the real one-liners', () => {
    expect(CLI_INSTALL_NPM).toBe('npm install -g @civitai/cli');
    expect(CLI_INSTALL_BREW).toBe('brew install civitai/tap/civitai');
    expect(CLI_INSTALL_GO).toBe('go install github.com/civitai/cli/cmd/civitai@latest');
    expect(CIVITAI_CLI_RELEASES_URL).toBe('https://github.com/civitai/cli/releases');
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
  /**
   * 🔴 THE CLOCK IS VIRTUAL, THE BEHAVIOUR IS NOT.
   *
   * Both copy tests used to assert `await expect.element(page.getByText('Copied'))`
   * on the REAL clock. "Copied" is not a settled end-state — it is TRANSIENT.
   * Mantine's `useClipboard` arms `setTimeout(() => setCopied(false), 1000)` the
   * moment the clipboard promise resolves, so the label exists for a ~1s window of
   * WALL-CLOCK time that starts closing before the assertion has read anything.
   * A retrying assertion cannot recover from missing it: it polls for PRESENCE, so
   * once the label is gone it just keeps polling an absent element until it times
   * out. Machine load, not a regression, then decides the verdict — which is
   * exactly how the keyboard case went red on civitai#3653's preview run after
   * passing 1280/1280 ten minutes earlier.
   *
   * MEASURED here on an idle box, instrumented, three consecutive runs: the label
   * appeared 0.0–0.1ms after the interaction resolved and was visible for
   * 976.7 / 995.6 / 999.4 / 1000.5 / 999.8 / 1001.2 ms. So the failure mode is NOT
   * clipboard permission (`test/component-setup.tsx` stubs `writeText` to a
   * resolving `vi.fn()`; probed `'clipboard' in navigator === true`,
   * `document.hasFocus() === true`) and NOT focus settling (`el.focus()` measured
   * 0.7ms and `document.activeElement === el` held every time). It is a real
   * timer in the component's dependency, raced by the assertion.
   *
   * Freezing `setTimeout` removes the dependency outright: the reset timer is
   * armed but virtual time never moves, so the label persists however slow the
   * runner is. Nothing about the component changes — the same `CopyButton` arms
   * the same `setTimeout`; only the reset's arrival is now under the test's
   * control, which lets the window be asserted explicitly instead of raced.
   */
  test('clicking the copy button copies — shows "Copied"', async () => {
    renderWithProviders(<CliSubmitCta />);
    const button = page.getByRole('button', { name: `Copy command: ${CLI_INSTALL_BREW}` });
    await expect.element(button).toBeInTheDocument();

    // Freeze BEFORE the interaction: the reset timer is armed by the copy itself,
    // and `vi.useFakeTimers()` does not retroactively capture an already-scheduled
    // real timer, so installing it afterwards would be too late.
    useVirtualClock();

    await button.click();
    await settleCopy();

    // (1) THE GUARD. CopyButton flips its render-prop `copied` → the Code block
    // text becomes "Copied" iff the activation triggered the `copy()` callback.
    // This is the assertion that fails if the button stops copying.
    expect(copiedLabels()).toBe(1);

    // (2) 1ms before the reset window closes, still copied — pins that the label
    // is the live copied STATE and not something that merely rendered once.
    await advance(COPIED_RESET_MS - 1);
    expect(copiedLabels()).toBe(1);

    // (3) Crossing the window resets it and the command comes back. Without this
    // half, (1) and (2) would also be satisfied by a copied state that never ends.
    await advance(1);
    expect(copiedLabels()).toBe(0);
    expect(page.getByText(`$ ${CLI_INSTALL_BREW}`).elements()).toHaveLength(1);
  });

  test('the copy button is focusable and keyboard-Enter copies — shows "Copied"', async () => {
    renderWithProviders(<CliSubmitCta />);
    const button = page.getByRole('button', { name: `Copy command: ${CLI_SUBMIT_COMMAND}` });
    await expect.element(button).toBeInTheDocument();
    const el = button.element() as HTMLElement;
    el.focus();
    expect(document.activeElement).toBe(el); // genuinely keyboard-reachable

    // Same reason as the mouse case above — freeze before the copy arms the reset.
    useVirtualClock();

    await userEvent.keyboard('{Enter}');
    await settleCopy();

    expect(copiedLabels()).toBe(1);

    await advance(COPIED_RESET_MS - 1);
    expect(copiedLabels()).toBe(1);

    await advance(1);
    expect(copiedLabels()).toBe(0);
    expect(page.getByText(`$ ${CLI_SUBMIT_COMMAND}`).elements()).toHaveLength(1);
  });
});
