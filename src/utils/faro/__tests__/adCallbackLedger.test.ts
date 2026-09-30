import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * 🔴 SEAM GUARD for rule 6b of `~/utils/faro/classifyException`. It pins a RELATIONSHIP that no
 * type, lint rule or other test couples, and it fails when the ledgered set GROWS **or** SHRINKS.
 *
 * WHAT CAN GO WRONG. Rule 6b drops a bare-network exception whose OUTERMOST stack frame is served
 * by an enumerated ad/analytics domain, reasoning that the outermost frame is whoever asked for
 * the request. A callback WE register with an ad SDK inverts that: the SDK invokes it from its own
 * queue or event, so the stack begins inside the SDK and our code sits INNER. If such a callback
 * issues a first-party `fetch` that fails, rule 6b drops a real first-party bug report — and the
 * stack is genuinely indistinguishable from an ad-initiated one, because in a production build
 * every frame of ours on it is the same minified chunk path (`/_next/static/chunks/<hash>.js`).
 * No signal remains to tell them apart, so this cannot be fixed downstream.
 *
 * 🔴 THE CHAIN IS LONGER THAN IT LOOKS, which is the main reason this file exists rather than a
 * comment. `AdsProvider`'s GPT `impressionViewable` callback calls `dispatchEvent(new
 * CustomEvent('civitai-ad-impression'))`, and `dispatchEvent` is SYNCHRONOUS — so every listener
 * of that event also runs with a GPT frame outermost, in a file that never mentions an ad SDK.
 * Both current listeners are safe, each for a DIFFERENT and non-obvious reason (one defers
 * through `setTimeout`, one hands off to a SharedWorker), so neither is safe by construction.
 *
 * WHAT TO DO WHEN THIS FAILS.
 *   - ADDED an ad-SDK callback, a synchronous dispatch out of one, or a listener of a dispatched
 *     event: confirm it issues no first-party `fetch` on the synchronous path, then ledger it. If
 *     it must fetch, DEFER the fetch (`setTimeout(() => …, 0)`) so the stack starts fresh and no
 *     ad frame is on it — the shape `useAdUnitImpressionTracked` already uses.
 *   - REMOVED one: delete its entry. A shrinking ledger matters too: it means this guard defends
 *     less than it claims.
 *   - ADDED a `fetch` to one of these files: check whether its call site is on the synchronous
 *     path from an ad-SDK callback. The three current ones are not — they are rooted in React
 *     effects and a `visibilitychange` DOM event — which is why a blanket "these files never
 *     fetch" assertion would be wrong, and is not what this file asserts.
 *
 * DELIBERATELY TEXTUAL. It greps rather than imports: these modules pull in React, the ad SDKs
 * and the provider tree, and the property under test is "where in the source does an ad SDK
 * receive one of our functions", which is a property of the text. Text cannot prove the absence
 * of a transitive fetch — the ledger is what makes a human look.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const read = (file: string) => readFileSync(join(REPO_ROOT, file), 'utf8');

const ADS_PROVIDER = 'src/components/Ads/AdsProvider.tsx';
const AD_UNIT_FACTORY = 'src/components/Ads/AdUnitFactory.tsx';
const IMPRESSION_HOOK = 'src/components/Ads/useAdUnitImpressionTracked.ts';

/** Files that may register a callback with an ad SDK, or listen to an event one dispatches. */
const AD_SEAM_FILES = [ADS_PROVIDER, AD_UNIT_FACTORY, IMPRESSION_HOOK];

/**
 * Every place our code runs on a stack an ad SDK started. `marker` must appear verbatim in
 * `file`; `safeBecause` is the reason it issues no first-party fetch synchronously.
 */
const AD_SDK_ENTRY_POINTS: ReadonlyArray<{ file: string; marker: string; safeBecause: string }> = [
  {
    file: ADS_PROVIDER,
    marker: "window.__tcfapi('addEventListener', 2, function (tcData: any, success: boolean) {",
    safeBecause: 'CMP consent callback — sets zustand state only.',
  },
  {
    file: ADS_PROVIDER,
    marker: 'window.googletag.cmd.push(function () {',
    safeBecause: 'GPT queue callback — only registers the impression listener below.',
  },
  {
    file: ADS_PROVIDER,
    marker: "addEventListener('impressionViewable'",
    safeBecause: 'GPT impression callback — dispatches a CustomEvent; see the dispatch hop below.',
  },
  {
    file: ADS_PROVIDER,
    marker: "dispatchEvent(new CustomEvent('civitai-ad-impression'",
    safeBecause:
      'SYNCHRONOUS hop out of the GPT callback — every listener of this event inherits the ad frame.',
  },
  {
    file: ADS_PROVIDER,
    marker: "window.addEventListener('civitai-ad-impression', listener)",
    safeBecause: 'Listener posts to a SharedWorker (`worker.send`); the fetch happens off-stack.',
  },
  {
    file: IMPRESSION_HOOK,
    marker: "window.addEventListener('civitai-ad-impression', listener)",
    safeBecause:
      'Listener DEFERS through setTimeout (asserted below), so its work runs on a fresh stack.',
  },
  {
    file: IMPRESSION_HOOK,
    marker: "window.addEventListener('civitai-custom-ad-impression', listener)",
    safeBecause: 'Same listener as above; the custom event is dispatched off a promise callback.',
  },
  {
    file: AD_UNIT_FACTORY,
    marker: 'window.adngin.queue.push(',
    safeBecause:
      'Snigel queue callback — calls startAuction through the SDK; no first-party fetch.',
  },
  {
    file: AD_UNIT_FACTORY,
    marker: 'window.googletag.cmd.push(function () {',
    safeBecause: 'GPT queue callback on unmount — destroys the slot; no network call.',
  },
  {
    file: AD_UNIT_FACTORY,
    marker: "new CustomEvent('civitai-custom-ad-impression'",
    safeBecause:
      'Dispatched from a fetch `.then` — microtask-rooted, so no ad frame, but it feeds the ' +
      'same listeners as the GPT-rooted dispatch and is ledgered for that reason.',
  },
];

/** First-party `fetch` call sites in these files, each recorded with what roots its stack. */
const FETCH_SITES: ReadonlyArray<{ file: string; marker: string; rootedIn: string }> = [
  {
    file: ADS_PROVIDER,
    marker: '/api/v1/serve?placement=probe',
    rootedIn: 'useEffect — React-rooted, no ad frame on the stack.',
  },
  {
    file: AD_UNIT_FACTORY,
    marker: '/api/v1/serve?${searchParams.toString()}',
    rootedIn: 'useEffect / interval tick — React- and timer-rooted.',
  },
  {
    file: AD_UNIT_FACTORY,
    marker: '/api/v1/view?trace=${data.trace}',
    rootedIn: 'visibilitychange DOM event handler — browser-rooted, not ad-SDK-rooted.',
  },
];

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

describe('ad-SDK seam ledger — rule 6b false-drop precondition', () => {
  // 🔴 POSITIVE CONTROL for the whole file. If the patterns cannot find the entry points we know
  // exist, every "nothing unledgered" assertion below is vacuous and passes on an empty match set.
  it('the entry patterns and the fetch pattern both actually match', () => {
    const entries = AD_SEAM_FILES.reduce((n, file) => {
      const src = read(file);
      return n + ENTRY_PATTERNS.reduce((m, re) => m + (src.match(re)?.length ?? 0), 0);
    }, 0);
    const fetches = AD_SEAM_FILES.reduce(
      (n, file) => n + (read(file).match(FETCH_RE)?.length ?? 0),
      0
    );
    expect(entries).toBeGreaterThanOrEqual(8);
    expect(fetches).toBe(FETCH_SITES.length);
  });

  // Fails if an entry point or a fetch site is added or removed without updating this file. Read
  // the docstring before changing a count — the point is to make you check the fetch precondition.
  it('the ledger sizes are exactly as expected', () => {
    expect(AD_SDK_ENTRY_POINTS).toHaveLength(10);
    expect(FETCH_SITES).toHaveLength(3);
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

  // The direction that matters: MORE ad-SDK entry points in the tree than the ledger knows about.
  it.each(AD_SEAM_FILES)('%s has no unledgered ad-SDK entry point', (file) => {
    const src = read(file);
    const found = ENTRY_PATTERNS.reduce((n, re) => n + (src.match(re)?.length ?? 0), 0);
    const ledgered = AD_SDK_ENTRY_POINTS.filter((s) => s.file === file).length;
    expect(
      found,
      `${file}: found ${found} ad-SDK entry points but the ledger lists ${ledgered}. ` +
        `A new one must be checked for a first-party fetch on its SYNCHRONOUS path, then added ` +
        `to AD_SDK_ENTRY_POINTS.`
    ).toBeLessThanOrEqual(ledgered);
  });

  // 🔴 The one entry point whose safety is a CODE PROPERTY rather than an absence, asserted
  // directly: the impression listener's work must stay behind a deferral. Delete the `setTimeout`
  // and this listener runs its body synchronously beneath the GPT frame.
  it('the impression listener still defers its work off the ad-SDK stack', () => {
    expect(read(IMPRESSION_HOOK)).toContain('setTimeout(() => setTracked(true), 1000)');
  });

  // And MORE fetch call sites than the ledger knows about — each needs its stack root checked.
  it.each(AD_SEAM_FILES)('%s has no unledgered first-party fetch', (file) => {
    const found = read(file).match(FETCH_RE)?.length ?? 0;
    const ledgered = FETCH_SITES.filter((s) => s.file === file).length;
    expect(
      found,
      `${file}: found ${found} fetch call sites but the ledger lists ${ledgered}. ` +
        `Check whether the new one is on the synchronous path from an ad-SDK callback; if it is, ` +
        `defer it through setTimeout. Then add it to FETCH_SITES.`
    ).toBe(ledgered);
  });
});
