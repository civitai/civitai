import type { ComponentProps } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup } from 'vitest-browser-react';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { BlockConsentNotice } from './BlockConsentNotice';

/**
 * THE MISSING-PERMISSIONS NOTICE: WHAT IT SAYS AND WHAT ITS BUTTONS DO.
 *
 * Widths and the narrow form are `BlockConsentNotice.geometry.test.tsx`; this file is
 * the `component` tier, where Tailwind's container-query variants are inert, so it
 * reads TEXT, attributes and handlers only — never which form is laid out.
 *
 * The sentence is read off the `data-form="wide"` span. That span is the one the
 * component renders the full sentence into at every width (it is clipped, not
 * removed, below the rung), so reading it is width-independent.
 */

const APP = 'Tipper';

function renderNotice(props: Partial<ComponentProps<typeof BlockConsentNotice>> = {}): {
  onReview: ReturnType<typeof vi.fn>;
  onDismiss: ReturnType<typeof vi.fn>;
} {
  const onReview = vi.fn();
  const onDismiss = vi.fn();
  renderWithProviders(
    <BlockConsentNotice appName={APP} onReview={onReview} onDismiss={onDismiss} {...props} />
  );
  return { onReview, onDismiss };
}

const notice = () => page.getByTestId('block-consent-notice').element() as HTMLElement;
const sentence = () =>
  (notice().querySelector('[data-form="wide"]')?.textContent ?? '').replace(/\s+/g, ' ').trim();

afterEach(() => cleanup());

describe('the sentence names what will not work', () => {
  test('🔴 names the missing permissions in GROUPED order, not in the order they arrived', async () => {
    // Input order: follow collections (not sensitive) then tip (sensitive). The shared
    // grouping rule puts the sensitive group first, so the sentence must read
    // tip → collections. A component that just mapped its input would read them reversed.
    renderNotice({ missingScopes: ['collections:write:self', 'social:tip:self'] });
    await expect.element(page.getByTestId('block-consent-notice')).toBeInTheDocument();
    expect(sentence()).toBe(
      "Tipper can't tip on your behalf or follow collections for you until you allow it."
    );
  });

  test('names a single permission without "or"', async () => {
    renderNotice({ missingScopes: ['social:tip:self'] });
    await expect.element(page.getByTestId('block-consent-notice')).toBeInTheDocument();
    expect(sentence()).toBe("Tipper can't tip on your behalf until you allow it.");
  });

  test('🔴 caps the list at two and says "and more" for the rest', async () => {
    // Three nameable scopes, listed in reverse of display order. Grouped: sensitive
    // [tip (has an OAuth bit), react (no bit, so after it)], then other [collections].
    // The cap keeps the first two, so the NON-sensitive one is what "and more" stands for.
    renderNotice({
      missingScopes: ['collections:write:self', 'social:react:self', 'social:tip:self'],
    });
    await expect.element(page.getByTestId('block-consent-notice')).toBeInTheDocument();
    expect(sentence()).toBe(
      "Tipper can't tip on your behalf, react to images for you and more until you allow it."
    );
  });

  test('falls back to the generic sentence when no missing scope can be named', async () => {
    for (const missingScopes of [undefined, [], ['not:a:real:scope']]) {
      renderNotice({ missingScopes });
      await expect.element(page.getByTestId('block-consent-notice')).toBeInTheDocument();
      expect(sentence(), `for ${JSON.stringify(missingScopes)}`).toBe(
        'Tipper is missing permissions it needs to work fully.'
      );
      await cleanup();
    }
  });

  test('an app with no name is "This app"', async () => {
    renderNotice({ appName: undefined, missingScopes: ['social:tip:self'] });
    await expect.element(page.getByTestId('block-consent-notice')).toBeInTheDocument();
    expect(sentence()).toBe("This app can't tip on your behalf until you allow it.");
  });
});

describe('it reads as action needed', () => {
  test('🔴 carries the warning variant and the shield-alert icon', async () => {
    renderNotice({ missingScopes: ['social:tip:self'] });
    await expect.element(page.getByTestId('block-consent-notice')).toBeInTheDocument();
    expect(notice().getAttribute('data-variant')).toBe('warning');
    const icon = page.getByTestId('block-consent-notice-icon').element();
    expect(icon.tagName.toLowerCase()).toBe('svg');
    // Decorative: the sentence carries the meaning, so the icon is hidden from AT.
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    // Still a status, never an alert.
    expect(notice().getAttribute('role')).toBe('status');
  });

  test('🔴 highlight is off by default and on only when the host says it was revived', async () => {
    renderNotice();
    await expect.element(page.getByTestId('block-consent-notice')).toBeInTheDocument();
    expect(notice().hasAttribute('data-highlight')).toBe(false);
    await cleanup();

    renderNotice({ highlight: true });
    await expect.element(page.getByTestId('block-consent-notice')).toBeInTheDocument();
    expect(notice().getAttribute('data-highlight')).toBe('true');
  });
});

test('🟢 tells the host when the flash has played, so a remount does not replay it', async () => {
  const onHighlightPlayed = vi.fn();
  renderNotice({ highlight: true, onHighlightPlayed });
  await expect.element(page.getByTestId('block-consent-notice')).toBeInTheDocument();
  expect(onHighlightPlayed).not.toHaveBeenCalled();
  // The component tier has no Tailwind, so no animation actually runs; dispatch the
  // event the browser fires when it ends.
  notice().dispatchEvent(new AnimationEvent('animationend', { bubbles: true }));
  await vi.waitFor(() => expect(onHighlightPlayed).toHaveBeenCalledTimes(1));
});

describe('the buttons', () => {
  test('🔴 "Allow…" is the primary button, opens the modal (onReview), and is named by its visible word', async () => {
    const { onReview, onDismiss } = renderNotice({ missingScopes: ['social:tip:self'] });
    // By ROLE + NAME: the accessible name must CONTAIN the visible text ("label in
    // name"), here it is exactly it.
    const allow = page.getByRole('button', { name: 'Allow…' });
    await expect.element(allow).toBeVisible();
    const el = allow.element() as HTMLElement;
    expect(el.getAttribute('data-testid')).toBe('block-consent-notice-review');
    expect(el.getAttribute('data-primary')).toBe('true');
    const visible = (el.querySelector('[data-form="wide"]')?.textContent ?? '').trim();
    expect(visible).toBe('Allow…');
    expect(el.getAttribute('aria-label') ?? '').toContain(visible);

    await allow.click();
    expect(onReview).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  test('Dismiss calls onDismiss only, and its label contains its visible word', async () => {
    const { onReview, onDismiss } = renderNotice({ missingScopes: ['social:tip:self'] });
    const dismiss = page.getByRole('button', { name: 'Dismiss the missing-permissions notice' });
    await expect.element(dismiss).toBeVisible();
    const el = dismiss.element() as HTMLElement;
    const visible = (el.querySelector('[data-form="wide"]')?.textContent ?? '').trim();
    expect(visible).toBe('Dismiss');
    expect(el.getAttribute('aria-label') ?? '').toContain(visible);
    // Not the primary action.
    expect(el.hasAttribute('data-primary')).toBe(false);

    await dismiss.click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onReview).not.toHaveBeenCalled();
  });
});
