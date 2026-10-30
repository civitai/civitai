import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';

// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { SearchRetryBanner } from '~/components/EndOfFeed/SearchRetryBanner';

/**
 * The banner shows on ANY image-feed failure, so its copy must not blame a particular backend.
 * Each state's text is pinned whole: a word-level check ("no 'search'") is walkable by rewording.
 */

// The countdown text is derived from `Date.now()` on a 200 ms interval, so pinning "600s" is only
// stable with both frozen. `setTimeout` stays real: `expect.element` polls on it.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

// The page's text, minus the `<style>` blocks MantineProvider injects (their CSS is text too).
const visibleText = () => {
  const body = document.body.cloneNode(true) as HTMLElement;
  body.querySelectorAll('style, script').forEach((node) => node.remove());
  return (body.textContent ?? '').replace(/\s+/g, ' ').trim();
};

describe('SearchRetryBanner copy', () => {
  test('gave-up state: neutral copy, and Try again still retries', async () => {
    const onRetry = vi.fn();
    renderWithProviders(
      <SearchRetryBanner delayMs={60_000} attempt={4} maxAttempts={3} onRetry={onRetry} />
    );

    const button = page.getByRole('button', { name: 'Try again' });
    await expect.element(button).toBeInTheDocument();
    expect(visibleText()).toBe(
      'Unable to load more images right now' +
        'Something went wrong on our end. Try again in a moment.' +
        'Try again'
    );

    await button.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test('countdown state (initial load): neutral copy', async () => {
    renderWithProviders(
      <SearchRetryBanner
        delayMs={600_000}
        attempt={1}
        maxAttempts={3}
        onRetry={() => undefined}
        isInitialLoad
      />
    );

    await expect.element(page.getByText("Couldn't load images yet")).toBeInTheDocument();
    expect(visibleText()).toBe(
      "Couldn't load images yet" +
        "We'll keep trying automatically." +
        'Retrying in 600s · Attempt 1 of 3'
    );
  });

  test('slow state (more images): neutral copy', async () => {
    renderWithProviders(
      <SearchRetryBanner
        delayMs={600_000}
        attempt={1}
        maxAttempts={3}
        onRetry={() => undefined}
        slow
      />
    );

    await expect
      .element(page.getByText('More images are taking longer than usual'))
      .toBeInTheDocument();
    expect(visibleText()).toBe(
      'More images are taking longer than usual' +
        "We'll keep trying automatically." +
        'Retrying in 600s · Attempt 1 of 3'
    );
  });

  test('slow state (initial load): neutral copy', async () => {
    renderWithProviders(
      <SearchRetryBanner
        delayMs={600_000}
        attempt={1}
        maxAttempts={3}
        onRetry={() => undefined}
        isInitialLoad
        slow
      />
    );

    await expect.element(page.getByText('Images are taking longer than usual')).toBeInTheDocument();
    expect(visibleText()).toBe(
      'Images are taking longer than usual' +
        "We'll keep trying automatically." +
        'Retrying in 600s · Attempt 1 of 3'
    );
  });

  // Absorbing: nothing in the test flips `countdownActive` back on.
  test('retrying-now state: neutral copy', async () => {
    renderWithProviders(
      <SearchRetryBanner
        delayMs={600_000}
        attempt={2}
        maxAttempts={3}
        onRetry={() => undefined}
        countdownActive={false}
      />
    );

    await expect.element(page.getByText('Retrying now — hang tight')).toBeInTheDocument();
    expect(visibleText()).toBe(
      'Retrying now — hang tight' + "We'll keep trying automatically." + 'Attempt 2 of 3'
    );
  });
});
