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
 * 🔴 BE PLAIN ABOUT WHAT THIS IS: a scan of the source text, not a render. It is what is available —
 * the component's other collaborators (trpc, Mantine providers, the notification helpers) put a real
 * render in the browser-mode project, and the property worth pinning here is structural anyway. So
 * it is deliberately narrow, and these are its blind spots: it sees the nearest ENCLOSING JSX
 * conditional of each control, so a gate satisfied by an unrelated expression that happens to
 * mention the flag would pass; and a control rendered through an indirection rather than as a JSX
 * element is invisible to it. The element COUNTS below are the control for the second: if a render
 * site moves out of reach, the count drops and this fails rather than silently covering less.
 */

const COMPONENT = path.resolve(__dirname, '../ArticleProblematicImages.tsx');

/** Every control that routes into a mutation the publish guard can refuse, and the flag that gates it. */
const GATED_CONTROLS: { element: string; flag: string; sites: number }[] = [
  // Calls `article.resolveImageScan` -> `resolveIngestionError`, which throws for an unrenderable
  // url. Rendered twice: once for blocked images, once for errored ones.
  { element: 'ImageOverrideControl', flag: 'remedy.offerOverride', sites: 2 },
  // Re-queues a scan of the same unfetchable url, so it re-fails and the article stays blocked.
  { element: 'ImageRetryButton', flag: 'remedy.offerRetry', sites: 1 },
];

const source = readFileSync(COMPONENT, 'utf8');
const lines = source.split('\n');

/** The nearest preceding JSX conditional — `{<expr> && (` — above a render site. */
function enclosingGate(atLine: number): string | null {
  for (let i = atLine; i >= 0; i--) if (lines[i].includes('&& (')) return lines[i];
  return null;
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

  it.each(GATED_CONTROLS)('gates every <$element> render on $flag', ({ element, flag, sites }) => {
    const renderSites = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => line.includes(`<${element}`));

    // Positive control on the scan: a zero here would make every assertion below vacuous, and the
    // exact count catches a render site that moved somewhere this scan cannot see.
    expect(renderSites, `render sites for <${element}>`).toHaveLength(sites);

    for (const { i } of renderSites) {
      const gate = enclosingGate(i);
      expect(
        gate,
        `<${element}> at line ${i + 1} must sit inside a JSX conditional`
      ).not.toBeNull();
      expect(gate, `<${element}> at line ${i + 1} is not gated on ${flag}`).toContain(flag);
    }
  });

  it('shows the remedy note wherever it withdraws the controls', () => {
    // Withdrawing the buttons without saying why would replace a dead-end click with a blank card,
    // which is a worse dead end: the reader is not told the image has to be removed or replaced.
    expect(source).toMatch(/remedy\.blockingNote/);
    // Once per section — the blocked list renders it beside the block reason, the error list
    // replaces the scan-failure cause with it.
    expect(source.match(/remedy\.blockingNote/g)).toHaveLength(3);
  });
});
