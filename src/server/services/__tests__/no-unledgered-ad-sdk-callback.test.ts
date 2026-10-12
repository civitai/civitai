import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * 🔴 SEAM GUARD for rule 6b of `~/utils/faro/classifyException`. It pins a RELATIONSHIP that no
 * type, lint rule or other test couples, and it fails when the ledgered set GROWS **or** SHRINKS.
 *
 * WHAT CAN GO WRONG. Rule 6b re-tags a bare-network exception whose OUTERMOST stack frame is
 * served by an enumerated ad/analytics domain, reasoning that the outermost frame is whoever asked
 * for the request. A callback WE register with an ad SDK inverts that: the SDK invokes it from its
 * own queue or event, so the stack begins inside the SDK and our code sits INNER. If such a
 * callback issues a first-party `fetch` that fails, rule 6b tags a real first-party bug as
 * `ad_initiated` and it leaves the `real` stream every alert and dashboard panel selects on — and
 * the stack is genuinely indistinguishable from an ad-initiated one, because in a production build
 * every frame of ours on it is the same minified chunk path (`/_next/static/chunks/<hash>.js`).
 * No signal remains to tell them apart, so this cannot be fixed downstream.
 *
 * (The beacon is still SENT and still queryable by its tag — which is why this is a mis-tag rather
 * than a silent loss, and why rule 6b tags instead of dropping. The guard exists because a bug
 * report outside the stream people watch is still a bug report nobody reads.)
 *
 * 🔴 THE CHAIN IS LONGER THAN IT LOOKS, which is the main reason this is a guard and not a
 * comment. `AdsProvider`'s GPT `impressionViewable` callback calls `dispatchEvent(new
 * CustomEvent('civitai-ad-impression'))`, and `dispatchEvent` is SYNCHRONOUS — so every listener
 * of that event also runs with a GPT frame outermost, in a file that never mentions an ad SDK.
 * Both current listeners are safe, each for a DIFFERENT and non-obvious reason (one defers through
 * `setTimeout`, one hands off to a SharedWorker), so neither is safe by construction.
 *
 * 🔴 THE FILE SET IS DERIVED, NOT LISTED. An earlier version hardcoded three files, which made its
 * own "fails when the set grows" promise false for a NEW file — and it was already missing one
 * (`src/pages/testing/ads.tsx`). The docstring was wider than the implementation, which is the
 * failure mode this guard exists to prevent. It now walks `src/` for the entry patterns.
 *
 * WHAT TO DO WHEN THIS FAILS.
 *   - ADDED an ad-SDK callback, a synchronous dispatch out of one, or a listener of a dispatched
 *     event: confirm it issues no first-party `fetch` on the synchronous path, then ledger it. If
 *     it must fetch, DEFER the fetch (`setTimeout(() => …, 0)`) so the stack starts fresh and no
 *     ad frame is on it — the shape `useAdUnitImpressionTracked` already uses.
 *   - REMOVED one: delete its entry. A shrinking ledger matters too: it means this guard defends
 *     less than it claims.
 *   - ADDED a `fetch` to a ledgered file: check whether its call site is on the synchronous path
 *     from an ad-SDK callback. The current ones are not — they are rooted in React effects and a
 *     `visibilitychange` DOM event — which is why a blanket "these files never fetch" assertion
 *     would be wrong, and is not what this asserts.
 *
 * DELIBERATELY TEXTUAL. It greps rather than imports: these modules pull in React, the ad SDKs and
 * the provider tree, and the property under test is "where in the source does an ad SDK receive
 * one of our functions", which is a property of the text. Text cannot prove the absence of a
 * TRANSITIVE fetch — the ledger is what makes a human look.
 */

const repoRoot = path.resolve(__dirname, '../../../..');
const srcRoot = path.join(repoRoot, 'src');

/** How an ad SDK receives one of our functions, or a synchronous hop out of such a callback. */
const ENTRY_PATTERNS = [
  /window\.googletag\.cmd\.push\(/g,
  /window\.adngin\.queue\.push\(/g,
  /window\.__tcfapi\(\s*'addEventListener'/g,
  /\.addEventListener\(\s*'impressionViewable'/g,
  /dispatchEvent\(\s*new CustomEvent\(\s*'civitai-(?:custom-)?ad-impression'/g,
  /window\.addEventListener\(\s*'civitai-(?:custom-)?ad-impression'/g,
];

const FETCH_RE = /(?<![.\w])fetch\s*\(/g;

/**
 * Walk `src/` for PRODUCTION source files. Derived so a NEW file carrying an entry pattern is
 * caught.
 *
 * 🔴 Test files are excluded, and not for tidiness: this guard quotes every entry pattern as a
 * marker string, so including tests makes it match ITSELF and report nine unledgered entry points
 * in its own body. A fixture's ad-SDK string is also not a production call site — only a shipped
 * one can put an ad frame on a real user's stack.
 */
const isTestFile = (p: string) =>
  /(?:^|[/\\])__tests__[/\\]/.test(p) || /\.(?:test|spec)\.[tj]sx?$/.test(p);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__snapshots__' || entry === '__tests__') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(?:tsx?|jsx?|mjs|cjs)$/.test(entry) && !isTestFile(full))
      // Posix separators: the ledger below is written with `/`, so on Windows every walked
      // path missed it and this guard reported all five of its own files as unledgered —
      // red for everyone locally, which masks a real failure rather than showing one.
      out.push(path.relative(repoRoot, full).split(path.sep).join('/'));
  }
  return out;
}

const countIn = (src: string, res: RegExp[]) =>
  res.reduce((n, re) => n + (src.match(re)?.length ?? 0), 0);

const ALL_SOURCES = walk(srcRoot);
/** Every file in `src/` that registers with an ad SDK — discovered, not declared. */
const AD_SEAM_FILES = ALL_SOURCES.filter(
  (f) => countIn(readFileSync(path.join(repoRoot, f), 'utf8'), ENTRY_PATTERNS) > 0
).sort();

/**
 * Every place our code runs on a stack an ad SDK started. `marker` must appear verbatim in `file`;
 * `safeBecause` records why it issues no first-party fetch synchronously.
 */
const AD_SDK_ENTRY_POINTS: ReadonlyArray<{ file: string; marker: string; safeBecause: string }> = [
  {
    file: 'src/components/Ads/AdsProvider.tsx',
    marker: "window.__tcfapi('addEventListener', 2, function (tcData: any, success: boolean) {",
    safeBecause: 'CMP consent callback — sets zustand state only.',
  },
  {
    file: 'src/components/Ads/AdsProvider.tsx',
    marker: 'window.googletag.cmd.push(function () {',
    safeBecause: 'GPT queue callback — only registers the impression listener below.',
  },
  {
    file: 'src/components/Ads/AdsProvider.tsx',
    marker: "addEventListener('impressionViewable'",
    safeBecause: 'GPT impression callback — dispatches a CustomEvent; see the dispatch hop below.',
  },
  {
    file: 'src/components/Ads/AdsProvider.tsx',
    marker: "dispatchEvent(new CustomEvent('civitai-ad-impression'",
    safeBecause:
      'SYNCHRONOUS hop out of the GPT callback — every listener of this event inherits the ad frame.',
  },
  {
    file: 'src/components/Ads/AdsProvider.tsx',
    marker: "window.addEventListener('civitai-ad-impression', listener)",
    safeBecause: 'Listener posts to a SharedWorker (`worker.send`); the fetch happens off-stack.',
  },
  {
    file: 'src/components/Ads/AdUnitFactory.tsx',
    marker: 'window.adngin.queue.push(',
    safeBecause:
      'Snigel queue callback — calls startAuction through the SDK; no first-party fetch.',
  },
  {
    file: 'src/components/Ads/AdUnitFactory.tsx',
    marker: 'window.googletag.cmd.push(function () {',
    safeBecause: 'GPT queue callback on unmount — destroys the slot; no network call.',
  },
  {
    file: 'src/components/Ads/AdUnitFactory.tsx',
    marker: "new CustomEvent('civitai-custom-ad-impression'",
    safeBecause:
      'Dispatched from a fetch `.then` — microtask-rooted, so no ad frame, but it feeds the same ' +
      'listeners as the GPT-rooted dispatch and is ledgered for that reason.',
  },
  {
    file: 'src/components/Ads/useAdUnitImpressionTracked.ts',
    marker: "window.addEventListener('civitai-ad-impression', listener)",
    safeBecause:
      'Listener DEFERS through setTimeout (asserted below), so its work runs on a fresh stack.',
  },
  {
    file: 'src/components/Ads/useAdUnitImpressionTracked.ts',
    marker: "window.addEventListener('civitai-custom-ad-impression', listener)",
    safeBecause: 'Same listener as above; the custom event is dispatched off a promise callback.',
  },
  {
    file: 'src/pages/testing/ads.tsx',
    marker: "window.__tcfapi('addEventListener', 2, (data: any, success: boolean) => {",
    safeBecause:
      'CMP consent callback on the ads testing page — calls setTcData (React state) only. ' +
      'Ledgered rather than exempted: the page is a normal route, so its stack shape is real.',
  },
];

/** First-party `fetch` call sites in the ledgered files, each with what roots its stack. */
const FETCH_SITES: ReadonlyArray<{ file: string; marker: string; rootedIn: string }> = [
  {
    file: 'src/components/Ads/AdsProvider.tsx',
    marker: '/api/v1/serve?placement=probe',
    rootedIn: 'useEffect — React-rooted, no ad frame on the stack.',
  },
  {
    file: 'src/components/Ads/AdUnitFactory.tsx',
    marker: '/api/v1/serve?${searchParams.toString()}',
    rootedIn: 'useEffect / interval tick — React- and timer-rooted.',
  },
  {
    file: 'src/components/Ads/AdUnitFactory.tsx',
    marker: '/api/v1/view?trace=${data.trace}',
    rootedIn: 'visibilitychange DOM event handler — browser-rooted, not ad-SDK-rooted.',
  },
];

const read = (file: string) => readFileSync(path.join(repoRoot, file), 'utf8');

describe('no unledgered ad-SDK callback — rule 6b mis-tag precondition', () => {
  // 🔴 POSITIVE CONTROLS. Without these, every "nothing unledgered" assertion below passes on an
  // empty match set — a walk that found no files, or patterns that match nothing, would read green.
  it('the walk, the entry patterns and the fetch pattern all actually match', () => {
    expect(ALL_SOURCES.length).toBeGreaterThan(1000);
    expect(AD_SEAM_FILES.length).toBeGreaterThanOrEqual(4);
    const entries = AD_SEAM_FILES.reduce((n, f) => n + countIn(read(f), ENTRY_PATTERNS), 0);
    expect(entries).toBeGreaterThanOrEqual(AD_SDK_ENTRY_POINTS.length);
    const fetches = FETCH_SITES.reduce((n, s) => n + countIn(read(s.file), [FETCH_RE]), 0);
    expect(fetches).toBeGreaterThanOrEqual(FETCH_SITES.length);
  });

  // The DERIVED file set must equal the files the ledger covers. A new file carrying an entry
  // pattern fails here — which the previous hardcoded version could not do.
  it('every file with an ad-SDK entry point is ledgered', () => {
    const ledgeredFiles = [...new Set(AD_SDK_ENTRY_POINTS.map((s) => s.file))].sort();
    expect(
      AD_SEAM_FILES,
      'these files register with an ad SDK; ledger each site in AD_SDK_ENTRY_POINTS'
    ).toEqual(ledgeredFiles);
  });

  it.each(AD_SDK_ENTRY_POINTS.map((s) => [s.file, s.marker] as const))(
    'ledgered ad-SDK entry point still exists: %s — %s',
    (file, marker) => {
      expect(read(file)).toContain(marker);
    }
  );

  it.each(FETCH_SITES.map((s) => [s.file, s.marker] as const))(
    'ledgered fetch site still exists: %s — %s',
    (file, marker) => {
      expect(read(file)).toContain(marker);
    }
  );

  // The direction that matters most: MORE entry points in a ledgered file than the ledger knows.
  it.each(AD_SEAM_FILES)('%s has no unledgered ad-SDK entry point', (file) => {
    const found = countIn(read(file), ENTRY_PATTERNS);
    const ledgered = AD_SDK_ENTRY_POINTS.filter((s) => s.file === file).length;
    expect(
      found,
      `${file}: found ${found} ad-SDK entry points but the ledger lists ${ledgered}. ` +
        `A new one must be checked for a first-party fetch on its SYNCHRONOUS path, then added ` +
        `to AD_SDK_ENTRY_POINTS.`
    ).toBeLessThanOrEqual(ledgered);
  });

  // And MORE fetch call sites than the ledger knows about — each needs its stack root checked.
  it.each([...new Set(AD_SDK_ENTRY_POINTS.map((s) => s.file))])(
    '%s has no unledgered first-party fetch',
    (file) => {
      const found = countIn(read(file), [FETCH_RE]);
      const ledgered = FETCH_SITES.filter((s) => s.file === file).length;
      expect(
        found,
        `${file}: found ${found} fetch call sites but the ledger lists ${ledgered}. ` +
          `Check whether the new one is on the synchronous path from an ad-SDK callback; if it ` +
          `is, defer it through setTimeout. Then add it to FETCH_SITES.`
      ).toBe(ledgered);
    }
  );

  // 🔴 The one entry point whose safety is a CODE PROPERTY rather than an absence, asserted
  // directly: the impression listener's work must stay behind a deferral. Delete the `setTimeout`
  // and this listener runs its body synchronously beneath the GPT frame.
  it('the impression listener still defers its work off the ad-SDK stack', () => {
    expect(read('src/components/Ads/useAdUnitImpressionTracked.ts')).toContain(
      'setTimeout(() => setTracked(true), 1000)'
    );
  });
});
