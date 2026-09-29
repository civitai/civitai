import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../../../../../test/strip-comments';

/**
 * ⚠️ A TEXT PIN, NOT COVERAGE. Nothing here renders the page or presses a key.
 *
 * This page records MODERATION VERDICTS from a `window` keydown listener: ArrowLeft submits "No",
 * ArrowRight submits "Yes". Nothing in the overlay stack stops keydown propagation -- bits-ui's
 * dialog handles only SPACE and ENTER, its escape layer only ESCAPE, its focus scope only Tab, and
 * none of them calls `stopPropagation` -- so an open Sheet does NOT shield the page. Arrow-scrolling
 * an open overlay recorded a verdict on the item behind it.
 *
 * Everything below reads COMMENT-STRIPPED source, through the app's one choke point. That is not
 * optional here: this file pins a page that carries breakage-guard comments naming the very
 * identifiers being pinned, so against raw text the ordering assertion would pass on its own
 * witness in a comment and stay green over a DELETED guard. `feedback-panel-tripwires.test.ts`
 * records three such incidents; this is the fourth site, not a new idea.
 */
const source = stripComments(
  readFileSync(fileURLToPath(new URL('../+page.svelte', import.meta.url)), 'utf8')
);

/** Every `X` in `<Sheet bind:open={X}>` — every overlay this page can put over the verdict UI. */
function boundOverlays(): string[] {
  return [...source.matchAll(/<Sheet\b[^>]*\bbind:open=\{([A-Za-z_$][\w$]*)\}/g)]
    .map((m) => m[1])
    .sort();
}

/**
 * The identifiers in `const overlayOpen = $derived(...)`. Greedy to the last `)` on the line, so a
 * call inside the expression cannot truncate the capture the way `[^)]*` would.
 */
function guardedOverlays(): string[] {
  const match = source.match(/const\s+overlayOpen\s*=\s*\$derived\((.+)\)\s*;/);
  if (!match) throw new Error('no `const overlayOpen = $derived(...)` in +page.svelte');
  return [...match[1].matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]).sort();
}

/** The body of the `window` keydown handler, from its signature to its registration. */
function keydownHandlerBody(): string {
  const start = source.indexOf('const handler = (e: KeyboardEvent)');
  if (start === -1) throw new Error('could not find the keydown handler in +page.svelte');
  const end = source.indexOf("window.addEventListener('keydown'", start);
  if (end === -1) throw new Error('could not find the keydown listener registration');
  return source.slice(start, end);
}

describe('scanner-audit keydown guard', () => {
  // Positive control. Every assertion below is a claim about parsed substrings; if a read or a
  // regex silently returned nothing, the set comparison would compare [] to [] and pass vacuously.
  it('parses a real page with at least one overlay and a verdict-submitting handler', () => {
    expect(source).toContain('submitAnswer');
    expect(boundOverlays().length).toBeGreaterThan(0);
    expect(keydownHandlerBody()).toContain('ArrowLeft');
  });

  // Control on the instrument itself: proves comments really are gone, so the pins below cannot be
  // satisfied by prose. Without it, a stripComments that silently no-opped would leave every
  // assertion here passing for the wrong reason.
  it('reads comment-stripped source, so no pin can be satisfied by a comment', () => {
    expect(source).not.toContain('Cmd+Left');
    expect(source).not.toContain('<!--');
  });

  it('guards the handler against EVERY overlay the page can open — no more, no fewer', () => {
    // Equality, not containment: a shrink is as dangerous as a growth, because an overlay dropped
    // from the guard is still openable and still swallows the arrow keys.
    expect(guardedOverlays()).toEqual(boundOverlays());
  });

  it('returns on an open overlay BEFORE it can submit a verdict', () => {
    const body = keydownHandlerBody();
    const guard = body.indexOf('if (overlayOpen) return;');
    const firstSubmit = body.indexOf('submitAnswer');
    expect(guard).toBeGreaterThan(-1);
    expect(firstSubmit).toBeGreaterThan(-1);
    // Ordering is the point: a guard after the submit calls would never run in time.
    expect(guard).toBeLessThan(firstSubmit);
  });

  it('ignores a modified arrow key, so browser-back cannot write a verdict on the way out', () => {
    // Cmd+Left / Alt+Left is browser-back. `xguard/+page.svelte` carries the same guard on an
    // identical handler; this page did not, and the defect lived on in the sibling.
    const body = keydownHandlerBody();
    const modifiers = body.indexOf('e.ctrlKey || e.metaKey || e.altKey || e.shiftKey');
    expect(modifiers).toBeGreaterThan(-1);
    expect(modifiers).toBeLessThan(body.indexOf('submitAnswer'));
  });
});
