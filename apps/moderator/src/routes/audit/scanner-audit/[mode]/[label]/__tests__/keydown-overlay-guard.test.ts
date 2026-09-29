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
 * `stopPropagation` appears nowhere in `bits-ui/dist` outside `slider` -- so an open overlay does
 * NOT shield the page. Arrow-scrolling an open overlay recorded a verdict on the item behind it.
 *
 * Everything reads COMMENT-STRIPPED source, through the app's one choke point. Not optional here:
 * this file pins a page carrying breakage-guard comments that name the very identifiers being
 * pinned, so against raw text the ordering assertion would pass on its own witness in a comment
 * and stay green over a DELETED guard. `feedback-panel-tripwires.test.ts` records three such
 * incidents; this is the fourth site, not a new idea.
 */
const raw = readFileSync(fileURLToPath(new URL('../+page.svelte', import.meta.url)), 'utf8');
const source = stripComments(raw);

/**
 * Overlay ROOT elements, counted by component rather than by binding syntax.
 *
 * 🔴 The count is the load-bearing assertion, not the names. A ledger keyed to one spelling of
 * `bind:open={X}` is blind to every other shape this app actually uses -- `<Sheet bind:open>`
 * shorthand (`audit/training-models/TrainingDataSheet.svelte:24`), `<Popover.Root bind:open>`
 * (`images/[slug]/TosDeleteButton.svelte:42`), `<Sheet open={x} onOpenChange={…}>`
 * (`reports/[slug]/+page.svelte:309`), and `<Dialog.Root>` with the binding on the NEXT line
 * (`lib/components/Lightbox.svelte:71`). Counting roots catches all of them, because any new
 * overlay adds a root whether or not its binding is parseable.
 *
 * KNOWN LIMIT, stated so this docstring is not wider than the code: the family list is enumerated
 * from `@civitai/ui`'s overlay components (sheet, dialog, alert-dialog, popover) plus `Drawer`. An
 * overlay built on a family NOT in this list is invisible here. Add it when one appears.
 */
const OVERLAY_ROOTS = /<(?:Sheet|Drawer)\b|<(?:Dialog|AlertDialog|Popover)\.Root\b/g;

function overlayRootCount(): number {
  return [...source.matchAll(OVERLAY_ROOTS)].length;
}

/** Plain-identifier `bind:open={X}` bindings — a subset of the roots above, never all of them. */
function namedOverlayBindings(): string[] {
  return [...source.matchAll(/\bbind:open=\{([A-Za-z_$][\w$]*)\}/g)].map((m) => m[1]).sort();
}

/**
 * The identifiers in `const overlayOpen = $derived(...)`. `[\s\S]` rather than `.` so a wrapped
 * expression -- which prettier produces past 100 chars, i.e. at roughly the fifth overlay -- does
 * not fail this suite while the guard is perfectly correct.
 */
function guardedOverlays(): string[] {
  const match = source.match(/const\s+overlayOpen\s*=\s*\$derived\(([\s\S]+?)\)\s*;/);
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
  // regex silently returned nothing, the comparisons would hold vacuously.
  it('parses a real page with at least one overlay and a verdict-submitting handler', () => {
    expect(source).toContain('submitAnswer');
    expect(overlayRootCount()).toBeGreaterThan(0);
    expect(keydownHandlerBody()).toContain('ArrowLeft');
  });

  // Control on the instrument, and SELF-INVALIDATING: it asserts the count MOVES. If the page
  // ever stops carrying comments, this fails loudly saying it can no longer observe stripping,
  // rather than passing over an un-stripped source the way a fixed-string pin would.
  it('reads comment-stripped source, so no pin can be satisfied by a comment', () => {
    const rawComments = (raw.match(/<!--|\/\//g) ?? []).length;
    expect(
      rawComments,
      'no comment left in +page.svelte — this control can no longer observe stripping'
    ).toBeGreaterThan(0);
    expect((source.match(/<!--/g) ?? []).length).toBe(0);
    expect(source.length).toBeLessThan(raw.length);
  });

  it('guards the handler against EVERY overlay the page can open — no more, no fewer', () => {
    // Count, not names: this is what sees an overlay whose binding shape the regex cannot read.
    // Equality, so a shrink fails too — an overlay dropped from the guard is still openable.
    expect(overlayRootCount()).toBe(guardedOverlays().length);
    // Stronger where the binding IS a plain identifier: those names must be the guarded ones.
    for (const name of namedOverlayBindings()) expect(guardedOverlays()).toContain(name);
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
