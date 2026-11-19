import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import {
  ReviewConsoleCountBadge,
  ReviewConsolePanel,
  ReviewConsoleProvider,
  ReviewConsoleSummary,
} from '~/components/Apps/ReviewConsole';
import {
  createReviewConsoleStore,
  type ReviewConsoleFrame,
} from '~/components/Apps/reviewConsoleStore';

/**
 * The review page's CONSOLE: the app's error reports from the review preview, kept in memory for
 * the moderator's own session and shown in the Console tab, with a count on the tab and in the
 * Overview, a Copy log button, and a notice when the app's SDK is too old to send non-fatal ones.
 *
 * The test plays the preview frame through the store's own frame sink — the two functions the
 * review host hands `PageBlockHost` as `onBlockError` / `onBlockReady`. That the review host
 * wires them is pinned in `ReviewBlockPreviewHost.browser.test.tsx`; that `PageBlockHost` calls
 * them with what the block posts, and advertises `blockErrors:v1` on `review-preview`, in
 * `PageBlockHostInitContractV2.browser.test.tsx`. No module is mocked here.
 */

const fetchSpy = vi.spyOn(window, 'fetch');

beforeEach(() => {
  fetchSpy.mockClear();
  vi.mocked(navigator.clipboard.writeText).mockClear();
});

let host: ReviewConsoleFrame;

/** The review page's arrangement, minus the tabs: the console's three views. */
async function mount() {
  const onOpen = vi.fn();
  const store = createReviewConsoleStore();
  host = store.openFrame();
  renderWithProviders(
    <ReviewConsoleProvider store={store}>
      <div data-testid="tab-badge">
        <ReviewConsoleCountBadge />
      </div>
      <ReviewConsoleSummary onOpen={onOpen} />
      <ReviewConsolePanel />
    </ReviewConsoleProvider>
  );
  await expect.element(page.getByTestId('apps-review-console')).toBeInTheDocument();
  return { onOpen, store };
}

/** The SDK's side: what `@civitai/sdk` posts, through the props the review host handed over. */
const sdk = {
  ready: (version: string, name = 'sdk') =>
    host.ready({ height: 0, sdkName: name, sdkVersion: version }),
  error: (message: string, extra: Record<string, unknown> = {}) =>
    host.report({
      message,
      fatal: false,
      source: 'error',
      at: Date.UTC(2026, 10, 19, 9, 30, 0),
      ...extra,
    }),
};

const entries = () => page.getByTestId('apps-review-console-entry').elements();
const messages = () =>
  page
    .getByTestId('apps-review-console-entry-message')
    .elements()
    .map((el) => el.textContent);

describe('ReviewConsole — collection in review mode', () => {
  test('🔴 a frame’s reports reach the console: time, source, message, collapsed stack', async () => {
    await mount();
    sdk.ready('0.29.0');
    sdk.error('Cannot read properties of undefined', {
      source: 'unhandledrejection',
      stack: 'TypeError: Cannot read properties of undefined\n    at load (app.js:4:2)',
    });
    sdk.error('render failed', { source: 'console', at: Date.UTC(2026, 10, 19, 9, 31, 0) });

    await vi.waitFor(() => expect(entries()).toHaveLength(2));
    expect(messages()).toEqual(['Cannot read properties of undefined', 'render failed']);
    const labels = page
      .getByTestId('apps-review-console-entry-label')
      .elements()
      .map((el) => el.textContent);
    expect(labels).toEqual(['unhandledrejection', 'console']);
    // The stack is there, and COLLAPSED until asked for.
    const stack = page
      .getByTestId('apps-review-console-entry-stack')
      .element() as HTMLDetailsElement;
    expect(stack.open).toBe(false);
    expect(stack.textContent).toContain('at load (app.js:4:2)');
    // A local time is shown for each.
    expect(entries()[0]!.textContent).toContain(
      new Date(Date.UTC(2026, 10, 19, 9, 30, 0)).toLocaleTimeString()
    );
  });

  test('🔴 a fatal crash shows FIRST, marked, with its reason — even when it came last', async () => {
    await mount();
    sdk.ready('0.29.0');
    sdk.error('a warning first', { source: 'console' });
    host.report({ message: 'Boot failed: missing manifest', fatal: true });

    await vi.waitFor(() => expect(entries()).toHaveLength(2));
    expect(messages()).toEqual(['Boot failed: missing manifest', 'a warning first']);
    expect(entries()[0]!.getAttribute('data-fatal')).toBe('true');
    await expect.element(page.getByTestId('apps-review-console-fatal-banner')).toBeInTheDocument();
    expect(page.getByTestId('apps-review-console-entry-label').elements()[0]!.textContent).toBe(
      'FATAL'
    );
  });

  test('🔴 nothing is sent anywhere: no POST, and nothing to the dev-preview reporter', async () => {
    await mount();
    sdk.ready('0.29.0');
    sdk.error('kept in memory only');
    await vi.waitFor(() => expect(entries()).toHaveLength(1));
    const sent = fetchSpy.mock.calls.filter(([input, init]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return url.includes('preview-errors') || (init?.method ?? 'GET').toUpperCase() !== 'GET';
    });
    expect(sent).toEqual([]);
  });
});

describe('ReviewConsole — two preview frames', () => {
  test('🔴 the Overview’s and the Preview tab’s runs are told apart, once both have reported', async () => {
    const { store } = await mount();
    sdk.ready('0.29.0');
    sdk.error('boom');
    await vi.waitFor(() => expect(entries()).toHaveLength(1));
    expect(page.getByTestId('apps-review-console-entry-frame').elements()).toHaveLength(0);
    store.openFrame().report({ message: 'boom', fatal: false, at: Date.UTC(2026, 10, 19, 9, 31) });
    await vi.waitFor(() => expect(entries()).toHaveLength(2));
    expect(
      page
        .getByTestId('apps-review-console-entry-frame')
        .elements()
        .map((el) => el.textContent)
    ).toEqual(['Preview 1', 'Preview 2']);
  });
});

describe('ReviewConsole — the old-SDK notice', () => {
  test('🔴 an app on @civitai/sdk below 0.29.0 gets the "too old" notice, naming its version', async () => {
    await mount();
    sdk.ready('0.28.0');
    await expect
      .element(page.getByTestId('apps-review-console-sdk-too-old'))
      .toHaveTextContent(
        "This app's SDK (@civitai/sdk 0.28.0) is too old to report other errors, so only fatal crashes show here."
      );
  });

  test('@civitai/blocks-react (which forwards none at any version) gets a notice that says so', async () => {
    await mount();
    sdk.ready('0.62.0', 'blocks-react');
    await expect
      .element(page.getByTestId('apps-review-console-sdk-too-old'))
      .toHaveTextContent(
        'This app uses @civitai/blocks-react 0.62.0, which does not report other errors'
      );
  });

  test('the cut-off itself, and anything above it, gets none', async () => {
    await mount();
    sdk.ready('0.29.0');
    await expect
      .element(page.getByTestId('apps-review-console-empty'))
      .toHaveTextContent('No errors reported.');
    expect(page.getByTestId('apps-review-console-sdk-too-old').elements()).toHaveLength(0);
    sdk.ready('1.0.3');
    expect(page.getByTestId('apps-review-console-sdk-too-old').elements()).toHaveLength(0);
  });

  test('before the app has started there is no verdict either way', async () => {
    await mount();
    await expect
      .element(page.getByTestId('apps-review-console-empty'))
      .toHaveTextContent('The app has not started yet.');
    expect(page.getByTestId('apps-review-console-sdk-too-old').elements()).toHaveLength(0);
  });
});

describe('ReviewConsole — the count badge', () => {
  test('🔴 the tab and the Overview count every report, red, and the Overview names a crash', async () => {
    const { onOpen } = await mount();
    // Zero: nothing on the tab, nothing in the Overview.
    expect(page.getByTestId('apps-review-console-count').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-review-overview-console').elements()).toHaveLength(0);

    sdk.ready('0.29.0');
    sdk.error('one');
    sdk.error('two');
    host.report({ message: 'it crashed', fatal: true });

    await expect.element(page.getByTestId('apps-review-console-count')).toHaveTextContent('3');
    await expect
      .element(page.getByTestId('apps-review-overview-console-count'))
      .toHaveTextContent('3 errors · 1 fatal');
    await expect
      .element(page.getByTestId('apps-review-overview-console'))
      .toHaveTextContent('Crashed: it crashed');
    // Red, not a neutral pill.
    expect(
      (page.getByTestId('apps-review-console-count').element() as HTMLElement).style.cssText
    ).toContain('red');
    await page.getByRole('button', { name: 'Open console' }).click();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe('ReviewConsole — Copy log', () => {
  test('🔴 copies the whole console, in display order: time, label, message, then the stack', async () => {
    await mount();
    sdk.ready('0.29.0');
    sdk.error('late warning', { source: 'console', at: Date.UTC(2026, 10, 19, 9, 32, 5) });
    sdk.error('Cannot read x', {
      source: 'error',
      at: Date.UTC(2026, 10, 19, 9, 31, 0),
      stack: 'TypeError: Cannot read x\n    at a (app.js:1:1)',
    });
    host.report({ message: 'gone', fatal: true, at: Date.UTC(2026, 10, 19, 9, 33, 0) });
    await vi.waitFor(() => expect(entries()).toHaveLength(3));

    await page.getByTestId('apps-review-console-copy').click();
    await vi.waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1));
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls[0]![0]).toBe(
      [
        'App console: 3 errors (SDK: @civitai/sdk 0.29.0)',
        '[2026-11-19T09:33:00.000Z] FATAL: gone',
        '[2026-11-19T09:31:00.000Z] error: Cannot read x',
        '    TypeError: Cannot read x',
        '        at a (app.js:1:1)',
        '[2026-11-19T09:32:05.000Z] console: late warning',
      ].join('\n')
    );
  });

  test('is disabled while there is nothing to copy', async () => {
    await mount();
    await expect.element(page.getByTestId('apps-review-console-copy')).toBeDisabled();
  });
});

describe('ReviewConsole — untrusted text stays text', () => {
  test('🔴 a message and a stack carrying HTML render as the literal characters, never as markup', async () => {
    await mount();
    sdk.ready('0.29.0');
    const hostile =
      '<img src=x onerror="window.__reviewConsolePwned=1"><b id="review-console-injected">bold</b>';
    sdk.error(hostile, { stack: `<script>window.__reviewConsolePwned=2</script>${hostile}` });
    host.report({ message: hostile, fatal: true });

    await vi.waitFor(() => expect(entries()).toHaveLength(2));
    // The exact characters, as text…
    expect(messages()).toEqual([hostile, hostile]);
    expect(page.getByTestId('apps-review-console-entry-stack').element().textContent).toContain(
      '<script>window.__reviewConsolePwned=2</script>'
    );
    await expect
      .element(page.getByTestId('apps-review-overview-console'))
      .toHaveTextContent(`Crashed: ${hostile}`);
    // …and no element was made from them, anywhere on the page.
    expect(document.getElementById('review-console-injected')).toBeNull();
    const panel = page.getByTestId('apps-review-console').element();
    expect(panel.querySelectorAll('img, b, script')).toHaveLength(0);
    expect(
      page.getByTestId('apps-review-overview-console').element().querySelectorAll('img, b, script')
    ).toHaveLength(0);
    expect((window as { __reviewConsolePwned?: number }).__reviewConsolePwned).toBeUndefined();
  });
});
