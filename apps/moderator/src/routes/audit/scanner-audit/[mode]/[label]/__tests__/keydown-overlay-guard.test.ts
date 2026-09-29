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
 * `stopPropagation` appears in exactly one file under `bits-ui/dist` (slider) -- so an open overlay
 * does NOT shield the page.
 *
 * 🔴 WHAT THIS CANNOT DO, stated first because three audit rounds each found an earlier version of
 * this docstring claiming more than the code delivered. A text pin cannot enumerate "every
 * overlay": the component vocabulary is open, and `@civitai/ui` ships a dozen floating families
 * (`select`, `dropdown-menu`, `combobox`, `command`, `context-menu`, `menubar`, `hover-card`,
 * `tooltip`, ...) whose arrow keys also reach `window`. This pin sees ONLY a `bind:open={ident}`
 * binding, on any component. An overlay that is uncontrolled, bound to a member expression, or
 * from a family nobody thought of is INVISIBLE to it, and the page is unguarded against it. The
 * durable fix is not a longer list -- it is for the handler to stop depending on an enumeration at
 * all. Recorded as open rather than implied away.
 */
const raw = readFileSync(fileURLToPath(new URL('../+page.svelte', import.meta.url)), 'utf8');
const source = stripComments(raw);

/** `bind:open={ident}` bindings, on any component. The only overlay shape this pin can read. */
function boundOverlays(): string[] {
  return [...source.matchAll(/\bbind:open=\{([A-Za-z_$][\w$]*)\}/g)].map((m) => m[1]).sort();
}

/**
 * `overlayOpen` parsed as a FLAT DISJUNCTION of identifiers, so this compares like with like.
 * An earlier version counted identifier TOKENS against overlay TAGS -- two different units, which
 * reddened correct code: `!done && (a || b)` is three tokens for two overlays, and `lb.open` is
 * two for one. Anything that is not a flat `a || b || c` fails here with an instruction, because a
 * shape this pin cannot read must not silently read as covered.
 */
function guardedOverlays(): string[] {
  const match = source.match(/const\s+overlayOpen\s*=\s*\$derived\(([^;]*)\)\s*;/);
  if (!match) throw new Error('no `const overlayOpen = $derived(...)` in +page.svelte');
  const parts = match[1].split('||').map((p) => p.trim());
  const bad = parts.filter((p) => !/^[A-Za-z_$][\w$]*$/.test(p));
  if (bad.length) {
    throw new Error(
      `keep \`overlayOpen\` a flat disjunction of plain identifiers so this guard can read it; ` +
        `cannot parse: ${bad.join(', ')}`
    );
  }
  return parts.sort();
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
  // Positive control: if a read or a regex silently returned nothing, the comparisons below would
  // hold vacuously.
  it('parses a real page with at least one overlay and a verdict-submitting handler', () => {
    expect(source).toContain('submitAnswer');
    expect(boundOverlays().length).toBeGreaterThan(0);
    expect(keydownHandlerBody()).toContain('ArrowLeft');
  });

  // Control on the INSTRUMENT, over a constructed input so it can never go vacuous. An earlier
  // version asserted a phrase from this page's own comments; that covered only the `<!--` class in
  // practice, and disabling `stripComments`' line-comment rule left this suite GREEN over a
  // DELETED guard whose text survived in a `//` comment -- measured. All three rules are pinned
  // here, on text this file owns.
  it('strips all three comment syntaxes, including the line comments this page uses', () => {
    const probe = 'keep1 <!-- drop1 --> keep2 /* drop2 */ keep3 // drop3\nkeep4';
    const stripped = stripComments(probe);
    expect(stripped).not.toContain('drop1');
    expect(stripped).not.toContain('drop2');
    expect(stripped).not.toContain('drop3');
    expect(stripped).toContain('keep1');
    expect(stripped).toContain('keep4');
    // `https://` is deliberately spared, so a URL must survive.
    expect(stripComments('a https://x/y b')).toContain('https://x/y');
  });

  // Real-data half: the page's own source must actually shrink, or the pins below read prose.
  it('reads comment-stripped page source', () => {
    expect(source.length).toBeLessThan(raw.length);
    expect(source).not.toContain('<!--');
  });

  it('guards the handler against every overlay it CAN see — no more, no fewer', () => {
    // Equality, so a shrink fails too: an overlay dropped from the guard is still openable.
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
    const body = keydownHandlerBody();
    const modifiers = body.indexOf('e.ctrlKey || e.metaKey || e.altKey || e.shiftKey');
    expect(modifiers).toBeGreaterThan(-1);
    expect(modifiers).toBeLessThan(body.indexOf('submitAnswer'));
  });
});
