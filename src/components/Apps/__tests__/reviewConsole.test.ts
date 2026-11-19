import { describe, expect, test } from 'vitest';
import {
  createReviewConsoleStore,
  orderReviewConsoleEntries,
  parseBlockReadySdk,
  REVIEW_CONSOLE_MIN_SDK,
  sdkForwardsReviewErrors,
} from '~/components/Apps/reviewConsole';
import {
  BLOCK_ERRORS_CAPABILITY,
  BLOCK_HOST_ERROR_REPORTS,
} from '~/components/AppBlocks/blockInitFragmentGate';

/**
 * The review console's rules, node-tier: the SDK cut-off for the "too old" notice, the entry cap
 * and the display order. The view is `ReviewConsole.browser.test.tsx`.
 */

describe('the SDK cut-off', () => {
  test('🔴 is @civitai/sdk 0.29.0, the first release that forwards to a review preview', () => {
    expect(REVIEW_CONSOLE_MIN_SDK).toEqual({
      name: 'sdk',
      packageName: '@civitai/sdk',
      version: '0.29.0',
    });
  });

  test.each([
    ['sdk', '0.29.0', true],
    ['sdk', '0.29.1', true],
    ['sdk', '0.30.0', true],
    ['sdk', '1.0.0', true],
    ['sdk', '0.29.0+build.5', true],
    ['sdk', '0.28.0', false],
    ['sdk', '0.28.99', false],
    ['sdk', '0.9.0', false],
    ['sdk', '0.29.0-beta.1', false],
    ['sdk', 'latest', false],
    ['sdk', null, false],
    ['blocks-react', '0.99.0', false],
    [null, '0.29.0', false],
  ] as const)('%s %s → %s', (name, version, expected) => {
    expect(sdkForwardsReviewErrors({ name, version })).toBe(expected);
  });

  test('BLOCK_READY fields are read as strings or not at all', () => {
    expect(parseBlockReadySdk({ height: 0, sdkName: 'sdk', sdkVersion: '0.29.0' })).toEqual({
      name: 'sdk',
      version: '0.29.0',
    });
    expect(parseBlockReadySdk({ height: 0 })).toEqual({ name: null, version: null });
    expect(parseBlockReadySdk({ sdkName: 3, sdkVersion: { v: 1 } })).toEqual({
      name: null,
      version: null,
    });
    expect(parseBlockReadySdk(null)).toEqual({ name: null, version: null });
  });
});

describe('the store', () => {
  test('keeps at most N entries, dropping the OLDEST non-fatal, never a fatal one', () => {
    const store = createReviewConsoleStore(3);
    store.report({ message: 'crash', fatal: true, at: 1 });
    store.report({ message: 'a', fatal: false, at: 2 });
    store.report({ message: 'b', fatal: false, at: 3 });
    store.report({ message: 'c', fatal: false, at: 4 });
    expect(store.getState().entries.map((e) => e.message)).toEqual(['crash', 'b', 'c']);
  });

  test('ignores a payload with no message, and notifies on each kept report', () => {
    const store = createReviewConsoleStore();
    let calls = 0;
    store.subscribe(() => (calls += 1));
    store.report({ fatal: false });
    store.report('not an object');
    store.report({ message: '   ', fatal: false });
    expect(store.getState().entries).toEqual([]);
    store.report({ message: 'kept', fatal: false, at: 5 });
    expect(calls).toBe(1);
  });

  test('display order: fatal first, then the rest, each oldest first', () => {
    const store = createReviewConsoleStore();
    store.report({ message: 'w2', fatal: false, at: 20 });
    store.report({ message: 'f2', fatal: true, at: 30 });
    store.report({ message: 'w1', fatal: false, at: 10 });
    store.report({ message: 'f1', fatal: true, at: 25 });
    expect(orderReviewConsoleEntries(store.getState().entries).map((e) => e.message)).toEqual([
      'f1',
      'f2',
      'w1',
      'w2',
    ]);
  });
});

describe('which surfaces advertise blockErrors:v1', () => {
  test('🔴 the review preview and the dev tunnel, and nowhere a published app runs', () => {
    expect(BLOCK_ERRORS_CAPABILITY).toBe('blockErrors:v1');
    expect(BLOCK_HOST_ERROR_REPORTS).toEqual({
      'model-slot': false,
      'page-run': false,
      'dev-tunnel': true,
      'review-preview': true,
      'private-run': false,
    });
  });
});
