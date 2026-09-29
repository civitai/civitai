import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * This page records MODERATION VERDICTS from a `window` keydown listener: ArrowLeft submits "No",
 * ArrowRight submits "Yes". Nothing in the Sheet primitive or in bits-ui's dialog stops keydown
 * propagation -- that dialog handles only SPACE and ENTER -- so an open overlay does NOT shield
 * the page. Scrolling an open Sheet with the arrow keys therefore submitted a verdict on the item
 * behind it, silently and with no undo.
 *
 * These assertions pin the RELATIONSHIP, not a spelling: every overlay the page can open must be
 * part of the expression the handler checks. The set test fails if it GROWS (a new overlay that
 * forgot to join) or SHRINKS (an overlay removed from the guard but still openable).
 */
const source = readFileSync(fileURLToPath(new URL('../+page.svelte', import.meta.url)), 'utf8');

/** Every `X` in `<Sheet bind:open={X}>` — i.e. every overlay this page can put over the verdict UI. */
function boundOverlays(): string[] {
  return [...source.matchAll(/<Sheet\b[^>]*\bbind:open=\{([A-Za-z_$][\w$]*)\}/g)]
    .map((m) => m[1])
    .sort();
}

/** The identifiers referenced by `const overlayOpen = $derived(...)`. */
function guardedOverlays(): string[] {
  const match = source.match(/const\s+overlayOpen\s*=\s*\$derived\(([^)]*)\)/);
  if (!match) throw new Error('no `const overlayOpen = $derived(...)` in +page.svelte');
  return [...match[1].matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]).sort();
}

/** The body of the `window` keydown handler, from its signature to its closing brace. */
function keydownHandlerBody(): string {
  const start = source.indexOf('const handler = (e: KeyboardEvent)');
  if (start === -1) throw new Error('could not find the keydown handler in +page.svelte');
  const end = source.indexOf("window.addEventListener('keydown'", start);
  if (end === -1) throw new Error('could not find the keydown listener registration');
  return source.slice(start, end);
}

describe('scanner-audit keydown guard', () => {
  // Positive control. Every assertion below is a claim about parsed substrings; if the read or a
  // regex silently returned nothing, the set comparison would compare [] to [] and pass vacuously.
  it('parses a real page with at least one overlay and a verdict-submitting handler', () => {
    expect(source).toContain('submitAnswer');
    expect(boundOverlays().length).toBeGreaterThan(0);
    expect(keydownHandlerBody()).toContain('ArrowLeft');
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
    // Ordering is the whole point: a guard placed after the submit calls would never run in time.
    expect(guard).toBeLessThan(firstSubmit);
  });
});
