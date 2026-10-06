// 🔴 THE REAL MANTINE STYLESHEET, AND IT IS LOAD-BEARING RATHER THAN COSMETIC. This tier
// injects `globals.css`'s `:root` custom properties and nothing else, so `<Code block>` has NO
// padding here — and the defect's own fixture is an EMPTY body (`joinUrl=""`), which then
// measures 414x0. Playwright refuses to click a zero-height box, so the click under test
// cannot be delivered at all: measured `boxWH=414x0 padding=0px` without this import and
// `boxWH=414x20 padding=10px 38px 10px 10px` with it. `test/geometry-setup.tsx`'s header
// records that per-file stylesheet imports in this tier stay supported, and that the UNLAYERED
// variant is what 7 files here take — layered styles would need the `@layer` order declaration
// this tier does not make. The PIXEL claims still belong to the `geometry` project, which
// declares that order; this import exists only so the body is a real click target.
import '@mantine/core/styles.css';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import {
  CollectionInviteLink,
  INVITE_LINK_COPY_LABEL,
  INVITE_LINK_TESTID,
} from './CollectionInviteLink';

/**
 * 🔒 A CLICK ON THE INVITE-LINK BODY DOES NOT COPY AN EMPTY STRING.
 *
 * The defect: `disabled={!joinUrl}` was on the icon and `onClick={copy}` was on the wrapping
 * `Box`, so the guard and the click path were on different elements. A click anywhere on the
 * value therefore ran `copy()` with `joinUrl === ''` — an empty string to the clipboard, and
 * the label flipped to "Copied", which tells the user they have an invite link on their
 * clipboard when they have nothing. The icon's `disabled` did not matter: it is not what was
 * clicked.
 *
 * 🔴 THE NEGATIVE CASE ASSERTS THE CLIPBOARD CALL AND NOTHING ELSE — ON PURPOSE, AND THE
 * SECOND ASSERTION IT USED TO CARRY WAS DELETED RATHER THAN REWORDED. That assertion was
 * `not.toHaveTextContent('Copied')` on the body, justified here as an independent "user-visible
 * half". It is neither independent nor an assertion. `@mantine/hooks`'s `useClipboard` calls
 * `setCopied(true)` ONLY inside `navigator.clipboard.writeText(...).then(...)`, so `copied` can
 * never be true unless `writeText` was called — the text claim is strictly implied by the one
 * below it. And it could not go red anyway: watched under the planted mutant with the two lines
 * SWAPPED so it reported first, it PASSED, because a retrying `.not.` assertion is satisfied at
 * its first poll, before React has re-rendered. An assertion that cannot fail reads as a second
 * guard while providing none.
 *
 * 🔴 THE POSITIVE CONTROL IS NOT OPTIONAL HERE. "writeText was not called" is exactly the
 * reassuring zero that a test wired to nothing also reports — if the click never reached the
 * handler for a fixture reason, the negative case passes for the wrong reason and passes just
 * as well with the fix reverted. So the same gesture on the same element with a REAL URL is
 * watched to copy, and it pins the BYTES (`toHaveBeenCalledWith`), not just a call count.
 *
 * 🔴 NO `'Copied'` LABEL ASSERTION ANYWHERE IN THIS FILE, AND AN EARLIER DRAFT HAD ONE IN THE
 * POSITIVE CASE WITH A COMMENT VOUCHING FOR IT. That comment said a positive retrying
 * assertion "polls until the state lands instead of racing it", which names the wrong half of
 * the hazard: the risk is the state LEAVING. Mantine's `CopyButton` carries
 * `defaultProps = { timeout: 1e3 }` and `useClipboard` arms
 * `setTimeout(() => setCopied(false), timeout)` from the copy itself, so `'Copied'` exists for
 * a ~1s REAL-clock window that is already closing when the assertion starts polling — and a
 * retrying assertion cannot recover from missing it. This is a measured, already-paid-for
 * flake in this repo: `src/components/Apps/CliSubmitCta.browser.test.tsx` records the label
 * alive for 976.7–1001.2ms across three runs, after the same shape went red on a preview run
 * having passed 1280/1280 ten minutes earlier.
 *
 * It is DELETED rather than hardened because it bought nothing the line above it does not:
 * `toHaveBeenCalledWith(JOIN_URL)` is what reds under both planted mutants, and the label's
 * only independent coverage is the `{copied ? 'Copied' : joinUrl}` render-prop wiring, which
 * this PR does not touch. 🔴 IF YOU EVER DO NEED THE LABEL PINNED, DO NOT RE-DERIVE IT —
 * `CliSubmitCta.browser.test.tsx` owns the solved pattern (`useVirtualClock()` installed
 * BEFORE the click, a pinned `COPIED_RESET_MS`, synchronous `elements().length` reads, and
 * boundary assertions at `−1`/`+1`ms). Copying its ~60 lines of clock machinery into here for
 * one downstream assertion is the trade that was declined, not an oversight.
 *
 * This is the `component` tier, not `geometry`. The claims are about the clipboard and the
 * accessibility tree; the stylesheet imported above is a prerequisite for delivering a click,
 * not something any assertion here reads. The PIXEL defect in the same control (the body
 * reserved no room for the icon overlapping it) is measured in
 * `src/components/CopyAffordance/CopyAffordance.geometry.test.tsx`, which declares the cascade
 * layer order this tier does not.
 *
 * 🔴 THIS SUITE CANNOT BE RUN AT `origin/main`, AND THE MATRIX'S "red at base" IS A SUBSTITUTE.
 * It imports `~/components/Collections/CollectionInviteLink`, a module this PR CREATES, so
 * there is no base revision at which the file resolves. What was actually watched to fail is
 * the base SHAPE: the guard reverted in place to `onClick={copy}` / unconditional
 * `cursor: pointer`, which is `CollectionEditModal.tsx`'s exact pre-PR JSX. That is the best
 * control available and it is a direct cost of extracting the module — stated here rather than
 * left for a reader to infer from a matrix row that says "origin/main's shape".
 */

const JOIN_URL = 'https://example.test/collections/42/join';

const writeText = () => vi.mocked(navigator.clipboard.writeText);

beforeEach(() => {
  writeText().mockClear();
});

/**
 * The element the handler is actually on — the `Box` wrapping the value and the icon.
 *
 * Clicking its centre lands on the `Code` body (the icon is absolutely positioned at the right
 * edge, and `page.getByTestId(...).click()` targets the centre), so this reproduces the user's
 * gesture: a press on the value, not on the control.
 */
const body = () => page.getByTestId(INVITE_LINK_TESTID);

describe('🔒 the invite-link body click is gated on there being a link', () => {
  // Title says only what is asserted. It used to end "and does not claim it did", whose
  // assertion was deleted (see the header) — leaving the most-read comment in the file
  // claiming coverage the body no longer had.
  test('a body click with no invite link puts nothing on the clipboard', async () => {
    renderWithProviders(<CollectionInviteLink joinUrl="" />);

    await expect.element(body()).toBeInTheDocument();
    await body().click();

    expect(
      writeText(),
      'a click on the invite-link body called `writeText` with no link to copy. The guard and ' +
        'the click path are on different elements again: `disabled` on the icon does not gate ' +
        'the `Box`"s `onClick`.'
    ).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ AN INVARIANT GUARD, NOT REGRESSION COVERAGE — LABELLED, BECAUSE THE MATRIX DOES NOT
   * COVER IT. Base already had `disabled={!joinUrl}` on the icon, and `disabled={!canCopy}`
   * with `canCopy = !!joinUrl` is boolean-identical to it, so this test passes at
   * `origin/main`'s shape too. The bug never violated this. Neither planted mutant touches
   * `disabled` — the inverted-guard mutant's one passing test IS this one.
   *
   * It is kept for what it pins going forward: the icon must not become reachable while the
   * body click is gated, which is the asymmetry the whole fix is about.
   *
   * 🔴 ALSO THE FILE'S ONE LITERAL ACCESSIBLE NAME, DELIBERATELY. Every other selector here
   * uses the imported `INVITE_LINK_COPY_LABEL`, so changing that constant to something useless
   * would move test and code together and stay green — "do not derive a test's expectation
   * from the implementation it tests", in the one property with a recorded history (this
   * control used to announce itself to a screen reader as just "button"). One literal is
   * enough to anchor it; repeating it at every call site only multiplies the edit cost when
   * the copy legitimately changes.
   */
  test('the control is disabled when there is no invite link', async () => {
    renderWithProviders(<CollectionInviteLink joinUrl="" />);

    const control = page.getByRole('button', { name: 'Copy the collection invite link' });
    await expect.element(control).toBeInTheDocument();
    await expect.element(control).toBeDisabled();
    expect(INVITE_LINK_COPY_LABEL).toBe('Copy the collection invite link');
  });

  test('POSITIVE CONTROL: the same gesture with a real link DOES copy it', async () => {
    renderWithProviders(<CollectionInviteLink joinUrl={JOIN_URL} />);

    await expect.element(body()).toBeInTheDocument();
    await body().click();

    // 🔴 THE EXACT BYTES, NOT `toHaveBeenCalled()`. A call with the wrong value is the other
    // way this control can lie, and a bare call-count assertion cannot see it.
    expect(writeText()).toHaveBeenCalledWith(JOIN_URL);
  });

  test('the control copies the link when it is the control that is pressed', async () => {
    renderWithProviders(<CollectionInviteLink joinUrl={JOIN_URL} />);

    const control = page.getByRole('button', { name: INVITE_LINK_COPY_LABEL });
    await expect.element(control).toBeEnabled();
    await control.click();

    // One press is one copy: the icon sits inside the `Box` that also handles the click, so a
    // press on it bubbles. The count is the part worth pinning — a `stopPropagation()` added
    // here later must not change it, and its absence must not double it.
    expect(writeText()).toHaveBeenCalledTimes(1);
    expect(writeText()).toHaveBeenCalledWith(JOIN_URL);
  });
});
