import { Profiler } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as StoreModule from '~/components/Apps/reviewConsoleStore';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { advanceBy, advanceUntil, fakeTimeouts } from '../../../test/fakeTimeouts';

/**
 * 🔴 THE CONSOLE'S RENDER COST UNDER A FLOOD OF REPORTS. An unapproved app can post
 * `BLOCK_ERROR` in a loop (with or without the SDK's rate limit), and the Console panel stays
 * mounted once visited. Each report used to notify the store's subscribers at once, and every
 * render rebuilt each row's frame label from the whole list: N reports cost N renders of
 * O(N² log N) each.
 *
 * Pinned here: a burst — each report its own task, as `postMessage` delivers them — commits the
 * panel ONCE, and that render's own label build runs ONCE, not once per row. The panel also hands
 * those labels to `formatReviewConsoleLog` for the Copy log; a module-internal call is not seen
 * by the spy, so that hand-off is NOT pinned here.
 *
 * The store module is spread and only `reviewConsoleFrameLabels` is wrapped in a spy, to count
 * the view's calls; every rule runs as written.
 */

vi.mock('~/components/Apps/reviewConsoleStore', async (importOriginal) => {
  const actual = await importOriginal<typeof StoreModule>();
  return { ...actual, reviewConsoleFrameLabels: vi.fn(actual.reviewConsoleFrameLabels) };
});

const { ReviewConsolePanel, ReviewConsoleProvider } = await import(
  '~/components/Apps/ReviewConsole'
);
const { createReviewConsoleStore, reviewConsoleFrameLabels, REVIEW_CONSOLE_NOTIFY_MS } =
  await import('~/components/Apps/reviewConsoleStore');

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
  test('🔴 commits the panel once and builds the frame labels once, however many reports arrive', async () => {
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
    vi.mocked(reviewConsoleFrameLabels).mockClear();
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
    expect(reviewConsoleFrameLabels).toHaveBeenCalledTimes(1);
    expect(
      page
        .getByTestId('apps-review-console-entry-frame')
        .elements()
        .slice(0, 2)
        .map((el) => el.textContent)
    ).toEqual(['Preview 1', 'Preview 2']);
  });
});
