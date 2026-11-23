import { Profiler } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { ReviewConsolePanel, ReviewConsoleProvider } from '~/components/Apps/ReviewConsole';
import {
  createReviewConsoleStore,
  REVIEW_CONSOLE_NOTIFY_MS,
} from '~/components/Apps/reviewConsoleStore';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { advanceBy, advanceUntil, fakeTimeouts } from '../../../test/fakeTimeouts';

/**
 * 🔴 A flood of `BLOCK_ERROR`s (an app need not go through the SDK's rate limit) re-renders the
 * mounted Console panel ONCE, not once per report. Each report is its own task, as `postMessage`
 * delivers them. That a render builds the frame labels once, not per row, is not pinned here.
 */

/** One macrotask, as each posted message is: React's own scheduled work runs before it ends. */
function nextMessageTask() {
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(null);
  });
}

const rendered = () => page.getByTestId('apps-review-console-entry').elements().length;

afterEach(() => {
  vi.useRealTimers();
});

describe('ReviewConsole — a burst of reports', () => {
  test('🔴 commits the panel once, however many reports arrive', async () => {
    fakeTimeouts();
    const store = createReviewConsoleStore();
    const overview = store.openFrame();
    const previewTab = store.openFrame();
    let commits = 0;
    renderWithProviders(
      <ReviewConsoleProvider store={store}>
        <Profiler id="console" onRender={() => (commits += 1)}>
          <ReviewConsolePanel />
        </Profiler>
      </ReviewConsoleProvider>
    );
    await advanceUntil(
      () => expect(page.getByTestId('apps-review-console-empty').elements()).toHaveLength(1),
      1_000
    );

    commits = 0;
    const N = 60;
    for (let i = 0; i < N; i += 1) {
      // Two frames, so every row carries a label and the label path is exercised.
      (i % 2 ? previewTab : overview).report({
        message: `e${i}`,
        fatal: false,
        source: 'console',
        at: 1_000 + i,
      });
      await nextMessageTask();
      await nextMessageTask();
    }
    // Nothing re-rendered while the burst was still arriving.
    expect(commits).toBe(0);

    await advanceBy(REVIEW_CONSOLE_NOTIFY_MS, REVIEW_CONSOLE_NOTIFY_MS);
    expect(rendered()).toBe(N);
    expect(commits).toBe(1);
    expect(
      page
        .getByTestId('apps-review-console-entry-frame')
        .elements()
        .slice(0, 2)
        .map((el) => el.textContent)
    ).toEqual(['Preview 1', 'Preview 2']);
  });
});
