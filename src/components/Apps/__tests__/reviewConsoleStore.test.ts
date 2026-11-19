import { afterEach, describe, expect, test, vi } from 'vitest';
import { assetsWithImageLevel, previewWithImageLevel } from '~/components/Apps/reviewImageLevels';
import {
  createReviewConsoleStore,
  formatReviewConsoleLog,
  reviewConsoleFrameLabels,
  orderReviewConsoleEntries,
  parseBlockReadySdk,
  REVIEW_CONSOLE_NOTIFY_MS,
  sdkForwardsReviewErrors,
} from '~/components/Apps/reviewConsoleStore';
import {
  BLOCK_ERRORS_CAPABILITY,
  BLOCK_HOST_ERROR_REPORTS,
} from '~/components/AppBlocks/blockInitFragmentGate';
import { reviewConsoleSdkNotice } from '~/components/Apps/reviewConsoleStore';

/**
 * The review console's rules, node-tier: the SDK cut-off for the "too old" notice, the entry cap
 * and the display order. The view is `ReviewConsole.browser.test.tsx`.
 */

describe('the SDK cut-off', () => {
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
    ['blocks-react', '0.85.0', true],
    ['blocks-react', '0.85.1', true],
    ['blocks-react', '1.0.0', true],
    ['blocks-react', '0.84.0', false],
    ['blocks-react', '0.85.0-next.1', false],
    // Each package against its OWN cut-off, never the other's.
    ['blocks-react', '0.29.0', false],
    ['sdk', '0.85.0', true],
    ['some-other-sdk', '9.9.9', false],
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

describe('the SDK notice, pinned whole', () => {
  test('an @civitai/sdk below the cut-off, or one that names no version, is too old', () => {
    expect(reviewConsoleSdkNotice({ name: 'sdk', version: '0.28.0' })).toBe(
      "This app's SDK (@civitai/sdk 0.28.0) is too old to report other errors, so only fatal crashes show here. Apps report every error from @civitai/sdk 0.29.0."
    );
    expect(reviewConsoleSdkNotice({ name: null, version: null })).toBe(
      "This app's SDK (an SDK that does not name itself) is too old to report other errors, so only fatal crashes show here. Apps report every error from @civitai/sdk 0.29.0 or @civitai/blocks-react 0.85.0."
    );
  });

  test('🔴 @civitai/blocks-react below ITS cut-off is too old, and is told its own version', () => {
    expect(reviewConsoleSdkNotice({ name: 'blocks-react', version: '0.84.0' })).toBe(
      "This app's SDK (@civitai/blocks-react 0.84.0) is too old to report other errors, so only fatal crashes show here. Apps report every error from @civitai/blocks-react 0.85.0."
    );
  });

  test('an app-sent name that is an Object.prototype key is an unknown SDK, not a lookup hit', () => {
    expect(reviewConsoleSdkNotice({ name: 'constructor', version: '1.0.0' })).toBe(
      "This app's SDK (constructor 1.0.0) is too old to report other errors, so only fatal crashes show here. Apps report every error from @civitai/sdk 0.29.0 or @civitai/blocks-react 0.85.0."
    );
  });

  test('🔴 @civitai/blocks-react at its cut-off gets no notice', () => {
    expect(reviewConsoleSdkNotice({ name: 'blocks-react', version: '0.85.0' })).toBeNull();
  });

  test('no notice at or above the cut-off, nor before BLOCK_READY', () => {
    expect(reviewConsoleSdkNotice({ name: 'sdk', version: '0.29.0' })).toBeNull();
    expect(reviewConsoleSdkNotice(null)).toBeNull();
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the store', () => {
  test('keeps at most N entries, dropping the OLDEST non-fatal, never a fatal one', () => {
    const store = createReviewConsoleStore(3);
    const frame = store.openFrame();
    frame.report({ message: 'crash', fatal: true, at: 1 });
    frame.report({ message: 'a', fatal: false, at: 2 });
    frame.report({ message: 'b', fatal: false, at: 3 });
    frame.report({ message: 'c', fatal: false, at: 4 });
    expect(store.getState().entries.map((e) => e.message)).toEqual(['crash', 'b', 'c']);
  });

  test('ignores a payload with no message, and notifies once one is kept', () => {
    vi.useFakeTimers();
    const store = createReviewConsoleStore();
    let calls = 0;
    store.subscribe(() => (calls += 1));
    const frame = store.openFrame();
    frame.report({ fatal: false });
    frame.report('not an object');
    frame.report({ message: '   ', fatal: false });
    vi.runAllTimers();
    expect(store.getState().entries).toEqual([]);
    expect(calls).toBe(0);
    frame.report({ message: 'kept', fatal: false, at: 5 });
    vi.runAllTimers();
    expect(calls).toBe(1);
  });

  test('🔴 a burst of reports notifies subscribers ONCE, not once per report', () => {
    // An app can post BLOCK_ERROR in a loop without the SDK's rate limit; each notification
    // re-renders every mounted console view.
    vi.useFakeTimers();
    const store = createReviewConsoleStore();
    let calls = 0;
    store.subscribe(() => (calls += 1));
    const frame = store.openFrame();
    for (let i = 0; i < 200; i += 1) frame.report({ message: `e${i}`, fatal: false, at: i });
    // The state is current at once, for any reader that renders before the notification.
    expect(store.getState().entries).toHaveLength(200);
    expect(calls).toBe(0);
    vi.advanceTimersByTime(REVIEW_CONSOLE_NOTIFY_MS);
    expect(calls).toBe(1);
    // And the next burst gets its own single notification.
    frame.report({ message: 'later', fatal: true, at: 999 });
    frame.ready({ sdkName: 'sdk', sdkVersion: '0.29.0' });
    vi.advanceTimersByTime(REVIEW_CONSOLE_NOTIFY_MS);
    expect(calls).toBe(2);
  });

  test('display order: fatal first, then the rest, each oldest first', () => {
    const store = createReviewConsoleStore();
    const frame = store.openFrame();
    frame.report({ message: 'w2', fatal: false, at: 20 });
    frame.report({ message: 'f2', fatal: true, at: 30 });
    frame.report({ message: 'w1', fatal: false, at: 10 });
    frame.report({ message: 'f1', fatal: true, at: 25 });
    expect(orderReviewConsoleEntries(store.getState().entries).map((e) => e.message)).toEqual([
      'f1',
      'f2',
      'w1',
      'w2',
    ]);
  });
});

describe('which surfaces advertise blockErrors:v1', () => {
  test('🔴 the review preview only: never where a published app runs, nor the dev tunnel (storageMode covers it)', () => {
    expect(BLOCK_ERRORS_CAPABILITY).toBe('blockErrors:v1');
    expect(BLOCK_HOST_ERROR_REPORTS).toEqual({
      'model-slot': false,
      'page-run': false,
      'dev-tunnel': false,
      'review-preview': true,
      'private-run': false,
    });
  });
});

describe('two preview frames', () => {
  test('🔴 each report carries its frame, labelled only once a second frame has reported', () => {
    const store = createReviewConsoleStore();
    const overview = store.openFrame();
    const previewTab = store.openFrame();
    overview.report({ message: 'boom', fatal: false, at: 1_000 });
    expect(reviewConsoleFrameLabels(store.getState().entries)).toEqual(new Map());
    previewTab.report({ message: 'boom', fatal: false, at: 2_000 });
    const entries = store.getState().entries;
    expect(entries.map((e) => reviewConsoleFrameLabels(entries).get(e.frame))).toEqual([
      'Preview 1',
      'Preview 2',
    ]);
    expect(formatReviewConsoleLog(store.getState())).toBe(
      [
        'App console: 2 errors (SDK: not started)',
        '[1970-01-01T00:00:01.000Z] Preview 1 error: boom',
        '[1970-01-01T00:00:02.000Z] Preview 2 error: boom',
      ].join('\n')
    );
  });

  test('frames are numbered by their FIRST report, not by when they opened', () => {
    const store = createReviewConsoleStore();
    const opened1 = store.openFrame();
    store.openFrame(); // frame 2 never reports
    const opened3 = store.openFrame();
    opened3.report({ message: 'a', fatal: false, at: 1 });
    opened1.report({ message: 'b', fatal: false, at: 2 });
    opened3.report({ message: 'c', fatal: false, at: 3 });
    expect(reviewConsoleFrameLabels(store.getState().entries)).toEqual(
      new Map([
        [3, 'Preview 1'],
        [1, 'Preview 2'],
      ])
    );
  });

  test('🔴 a report time no Date can hold is replaced, so the Copy log cannot throw', () => {
    const store = createReviewConsoleStore();
    store.openFrame().report({ message: 'crafted', fatal: false, at: 9e15 });
    expect(() => formatReviewConsoleLog(store.getState())).not.toThrow();
    expect(Math.abs(store.getState().entries[0]!.at)).toBeLessThanOrEqual(8.64e15);
  });
});

describe('a re-rate applied to the cached reads', () => {
  const assets = {
    iconId: 1,
    coverId: 2,
    iconNsfwLevel: 1,
    coverNsfwLevel: 4,
    redIconId: 3,
    redCoverId: null,
    redIconNsfwLevel: 8,
    redCoverNsfwLevel: null,
    screenshots: [
      { imageId: 5, nsfwLevel: 2 },
      { imageId: 2, nsfwLevel: 4 },
    ],
  };

  test('🔴 moves every slot that shows the image, and only those', () => {
    expect(assetsWithImageLevel(assets, 2, 16)).toEqual({
      ...assets,
      coverNsfwLevel: 16,
      screenshots: [
        { imageId: 5, nsfwLevel: 2 },
        { imageId: 2, nsfwLevel: 16 },
      ],
    });
    expect(assetsWithImageLevel(assets, 3, 1)).toEqual({ ...assets, redIconNsfwLevel: 1 });
    expect(assetsWithImageLevel(assets, 99, 1)).toEqual(assets);
    expect(assetsWithImageLevel(undefined, 2, 1)).toBeUndefined();
  });

  test('the review preview media, the same way', () => {
    const preview = {
      card: { id: 'c' },
      media: {
        icon: { imageId: 1, url: 'u1', nsfwLevel: 1 },
        cover: { imageId: 2, url: 'u2', nsfwLevel: 4 },
        redIcon: null,
        redCover: null,
        screenshots: [{ imageId: 2, url: 'u3', nsfwLevel: 4, caption: null }],
      },
    };
    expect(previewWithImageLevel(preview, 2, 2)).toEqual({
      card: { id: 'c' },
      media: {
        icon: { imageId: 1, url: 'u1', nsfwLevel: 1 },
        cover: { imageId: 2, url: 'u2', nsfwLevel: 2 },
        redIcon: null,
        redCover: null,
        screenshots: [{ imageId: 2, url: 'u3', nsfwLevel: 2, caption: null }],
      },
    });
    expect(previewWithImageLevel(null, 2, 2)).toBeNull();
  });
});
