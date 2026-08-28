import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * 🔴 SOURCE GATE — the article surface must not render a control that can only fail.
 *
 * `articleImageActions` decides which affordances survive for an image whose url the publish guard
 * refuses, and its own suite covers that decision exhaustively. This covers the OTHER half: that
 * `ArticleProblematicImages` actually gates its two controls on it. Those are separately correct and
 * jointly broken if the wiring is dropped — the isolation-seam shape — and dropping it is invisible
 * to every other test in the repo.
 *
 * 🔴 BE PLAIN ABOUT WHAT THIS IS: a scan of the source text, not a render. The behaviour is covered
 * by `ArticleProblematicImages.browser.test.tsx`, which renders the component and reads the DOM;
 * this file pins the STRUCTURE that makes the behaviour hard to break by accident.
 *
 * 🔴 IT NO LONGER GUESSES AT THE ENCLOSING JSX CONDITIONAL, and that change is the point. The
 * previous version walked backwards for the nearest line containing `&& (` — the nearest, not the
 * syntactic parent — so it could certify that a flag appears somewhere above a tag and nothing about
 * reachability. It also could not see the defect that actually existed: the flag was spelled TWICE,
 * once on the container and once on the child, and the container already rejected exactly the inputs
 * the child's copy existed to reject, so removing the child's copy changed nothing and a mutation
 * test on it SURVIVED.
 *
 * The component now names ONE boolean per affordance, so the structure is directly readable: this
 * file checks (a) that each boolean's DEFINITION consults the shared helper's corresponding field,
 * and (b) that every render site is gated on that boolean and nothing else. Remaining blind spot: a
 * control rendered through an indirection rather than as a JSX element is invisible here. The
 * element COUNTS are the control for it — if a render site moves out of reach the count drops and
 * this fails rather than silently covering less.
 */

const COMPONENT = path.resolve(__dirname, '../ArticleProblematicImages.tsx');

/**
 * Every control that routes into a mutation the publish guard can refuse: the element, the boolean
 * that gates every one of its render sites, the `articleImageActions` field that boolean must be
 * derived from, and how many times it is rendered.
 */
const GATED_CONTROLS: { element: string; flag: string; field: string; sites: number }[] = [
  // Calls `article.resolveImageScan` -> `resolveIngestionError`, which throws for an unrenderable
  // url. Rendered twice: once for blocked images, once for errored ones.
  {
    element: 'ImageOverrideControl',
    flag: 'showOverride',
    field: 'remedy.offerOverride',
    sites: 2,
  },
  // Re-queues a scan of the same unfetchable url, so it re-fails and the article stays blocked.
  { element: 'ImageRetryButton', flag: 'showRetry', field: 'remedy.offerRetry', sites: 1 },
];

const source = readFileSync(COMPONENT, 'utf8');
const lines = source.split('\n');

/**
 * Every `const <flag> = <expr>;` in the component — the single definition of each affordance.
 *
 * Read off a WHITESPACE-FLATTENED copy, not line by line: prettier wraps these declarations once
 * they exceed the print width, and a line-scoped regex silently returned `const showOverride =`
 * with the expression on the next line — a match that then "contained" nothing and failed for a
 * reason that had nothing to do with the code.
 */
const flatSource = source.replace(/\s+/g, ' ');
function definitionsOf(flag: string): string[] {
  return [...flatSource.matchAll(new RegExp(`const ${flag} = ([^;]*);`, 'g'))].map((m) => m[1]);
}

describe('the article surface and the publish guard cannot disagree about blob: urls', () => {
  it('takes its decision from the shared helper, never a local copy of the rule', () => {
    // A second spelling of the predicate here is how the two runtimes came to disagree about the
    // same row once already; the helper is the single place that consults `isUnrenderableMediaUrl`.
    expect(source).toContain("from './articleImageActions'");
    expect(source).toMatch(/const remedy = articleImageActions\(image\.url\)/);
    // ...and never re-derives it. `blob` must not appear in this file at all.
    expect(source).not.toMatch(/\bblob\b/i);
  });

  it.each(GATED_CONTROLS)(
    'derives $flag from $field, once per section',
    ({ flag, field, sites }) => {
      const definitions = definitionsOf(flag);

      // Positive control on the scan, and the thing that catches a SECOND spelling appearing: one
      // definition per section that renders the control, no more.
      expect(definitions, `definitions of ${flag}`).toHaveLength(sites);

      for (const def of definitions) {
        expect(def, `${flag} must be derived from ${field}`).toContain(field);
        // ...and from the shared helper's field, not a re-derivation of the rule. `blob` is already
        // banned from this whole file by the case above; this catches the subtler shape where the
        // flag reads some OTHER property and merely happens to be named right.
        expect(def, `${flag} must not invert ${field}`).not.toContain(`!${field}`);
      }
    }
  );

  it.each(GATED_CONTROLS)('gates every <$element> render on $flag', ({ element, flag, sites }) => {
    const renderSites = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => line.includes(`<${element}`));

    // Positive control on the scan: a zero here would make every assertion below vacuous, and the
    // exact count catches a render site that moved somewhere this scan cannot see.
    expect(renderSites, `render sites for <${element}>`).toHaveLength(sites);

    for (const { line, i } of renderSites) {
      /**
       * The gate is on the render site's own line, or on the line immediately above it when
       * prettier has wrapped the element onto its own line. Two lines, not "walk back until
       * something matches" — a bounded window is what makes this a claim about THIS site rather
       * than about whatever conditional happened to appear earlier in the file.
       */
      const window = [lines[i - 1] ?? '', line].join(' ').replace(/\s+/g, ' ');
      expect(window, `<${element}> at line ${i + 1} is not gated on ${flag}`).toContain(
        `{${flag} && `
      );
    }
  });

  it('shows the remedy note wherever it withdraws the controls', () => {
    // Withdrawing the buttons without saying why would replace a dead-end click with a blank card,
    // which is a worse dead end: the reader is not told the image has to be removed or replaced.
    expect(source).toMatch(/remedy\.blockingNote/);
    // 🔴 THREE MENTIONS ACROSS TWO SECTIONS, NOT "once per section" — the previous comment said the
    // latter while asserting the former, so the number and the sentence disagreed and only the
    // number was true. The blocked list spends TWO (`{remedy.blockingNote && (` to decide whether
    // to render, then the value itself); the error list spends ONE, because it substitutes the note
    // for the scan-failure cause with `??` and needs no separate guard.
    expect(source.match(/remedy\.blockingNote/g)).toHaveLength(3);
  });

  it('keeps the Overridden STATUS reachable when it withdraws the override ACTION', () => {
    /**
     * 🔴 The status and the action used to be one component, so gating that component on
     * `remedy.offerOverride` withdrew the badge too. The state it reports is reachable for exactly
     * these images — `updateImageNsfwLevel` sets `nsfwLevelLocked` without touching `ingestion` —
     * so the reader could see a card whose override had already been applied with nothing saying so.
     *
     * Pinned in BOTH directions: the badge must render, and it must not be gated on the flag that
     * withdraws the action. `enclosingGate` is deliberately not used here — the badge is rendered
     * inline, and what matters is the gating expression ON ITS OWN LINE.
     */
    const badgeSites = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => line.includes('<ImageOverriddenBadge'));

    // Positive control: a zero here makes everything below vacuous. Two sections render it.
    expect(badgeSites, 'render sites for <ImageOverriddenBadge>').toHaveLength(2);

    for (const { line, i } of badgeSites) {
      expect(line, `<ImageOverriddenBadge> at line ${i + 1} must gate on showOverridden`).toContain(
        '{showOverridden && '
      );
    }

    // ...and `showOverridden` reads the LOCK and nothing else. This is the assertion that fails if
    // the badge is re-coupled to the withdrawal: one definition per section, each derived from
    // `image.nsfwLevelLocked`, none of them consulting `remedy`.
    const definitions = definitionsOf('showOverridden');
    expect(definitions, 'definitions of showOverridden').toHaveLength(2);
    for (const def of definitions) {
      expect(def, 'showOverridden must gate on the lock').toContain('image.nsfwLevelLocked');
      expect(def, 'showOverridden must not consult the withdrawal').not.toContain('remedy.');
    }
  });
});
