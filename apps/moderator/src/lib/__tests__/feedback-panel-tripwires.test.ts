import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FEEDBACK_PROMOTE_DRAFT_FIELDS } from '$lib/feedback-drafts';

/**
 * ⚠️⚠️ TRIPWIRES, NOT COVERAGE. READ THIS BEFORE TRUSTING ANYTHING BELOW.
 *
 * Every assertion in this file matches TEXT in a `.svelte` file. None of them renders a component,
 * clicks anything, or observes a single byte of behaviour. They are here because this app has no
 * Svelte test tier at all — `vitest.config.ts` is `environment: 'node'` and its `include` matches
 * only `.test.ts` / `.spec.ts` under `src`, so no `.svelte` file is ever collected; and
 * `vitest-browser-svelte` is not a dependency. Decisions that are load-bearing at RUNTIME are
 * therefore reachable by no test that exists.
 *
 * 🔴 THEY ARE WALKABLE BY REWORDING, AND THAT IS INHERENT. A rewrite that is semantically identical
 * and textually different fails them; a rewrite that is textually identical and semantically broken
 * passes them. They can catch a DELETION or a "simplification" that removes a construct. They cannot
 * certify that the construct works — every one of these decisions was originally verified by reading
 * the library source, and that is still the only evidence behind them.
 *
 * Do not count these toward coverage of the panel. If a Svelte browser tier ever lands here, the
 * behavioural version of each of these replaces it rather than joining it.
 */

const dir = path.dirname(fileURLToPath(import.meta.url));
const feedbackDir = path.resolve(dir, '../../routes/feedback');

/** Collapse runs of whitespace so an assertion survives reflowing and reindentation, only. */
const source = (file: string): string =>
  readFileSync(path.resolve(feedbackDir, file), 'utf-8').replace(/\s+/g, ' ');

const componentSource = (file: string): string =>
  readFileSync(path.resolve(dir, '../components', file), 'utf-8').replace(/\s+/g, ' ');

describe('the instrument itself', () => {
  /**
   * 🔴 A POSITIVE CONTROL, and the reason it is first. Every other test in this file asserts that a
   * string IS present; if `source()` silently returned `''` for a moved or renamed file, `toContain`
   * would fail loudly — but a future test written the other way round (`not.toContain`) would pass
   * over an empty string forever. Pin that the files are real and non-trivial here, once.
   */
  it('reads the files it claims to read', () => {
    for (const file of [
      'FeedbackDetail.svelte',
      'FeedbackPromote.svelte',
      'FeedbackAttachments.svelte',
      '+page.svelte',
    ]) {
      expect(source(file).length).toBeGreaterThan(500);
    }
    expect(componentSource('Lightbox.svelte').length).toBeGreaterThan(500);
  });
});

describe('typed text outlives a tab click', () => {
  /**
   * The triage note box. A tab is a navigation and the `{#if activeTab === …}` chain destroys the
   * branch, so an unbound `value=` leaves the operator's half-written internal note in a DOM node
   * that is about to stop existing. `bind:value` to state declared in `FeedbackDetail` — the one
   * component that survives the navigation — is what keeps it.
   */
  it('binds the triage note rather than passing an unbound value', () => {
    const detail = source('FeedbackDetail.svelte');
    expect(detail).toContain('name="note" rows={2} bind:value={note}');
    expect(detail).not.toContain("value={row.triageNote ?? ''} />");
  });

  it('re-seeds the note from the reloaded column on a successful save', () => {
    expect(source('FeedbackDetail.svelte')).toContain("note = row.triageNote ?? '';");
  });

  /**
   * 🔴 THE LEDGER PIN, and the only assertion here that fails on an ADDITION rather than a deletion.
   * Every operator-typed box in the promote form must be bound to the parent-owned draft. A new box
   * added to that form without a draft field is an uncontrolled input — the exact defect — and it
   * fails here because the set of `name=` attributes stops matching `FEEDBACK_PROMOTE_DRAFT_FIELDS`.
   *
   * `<Input>`/`<Textarea>` only: the two lowercase `<input type="hidden">` elements carry `id` and
   * `mode`, which nobody types into and which the draft deliberately does not hold.
   */
  it('binds every box in the promote form to the hoisted draft', () => {
    const promote = source('FeedbackPromote.svelte');
    const boxes = promote.match(/<(Input|Textarea)\b[^>]*>/g) ?? [];

    // Instrument check: a regex that matched nothing would make the next assertion vacuously true
    // only if the ledger were also empty — assert both ends are non-empty before comparing them.
    expect(boxes.length).toBeGreaterThan(0);
    expect(FEEDBACK_PROMOTE_DRAFT_FIELDS.length).toBeGreaterThan(0);

    const named = boxes.flatMap((box) => box.match(/name="([^"]+)"/)?.[1] ?? []);
    expect(named.sort()).toEqual([...FEEDBACK_PROMOTE_DRAFT_FIELDS].sort());

    for (const field of FEEDBACK_PROMOTE_DRAFT_FIELDS) {
      const box = boxes.find((candidate) => candidate.includes(`name="${field}"`));
      expect(box, `no <Input>/<Textarea> posts name="${field}"`).toBeDefined();
      expect(box).toContain(`bind:value={draft.${field}}`);
    }
  });

  /** The mode toggle is draft state too: flipping to "attach", then to Context and back, kept it. */
  it('drives the promote mode from the draft, not from component-local state', () => {
    const promote = source('FeedbackPromote.svelte');
    expect(promote).toContain("value={draft.attachMode ? 'attach' : 'create'}");
    expect(promote).not.toContain('let attachMode = $state(');
  });
});

describe('at most one refusal is live', () => {
  /**
   * The cross-clearing wiring behind `feedbackRefusal`'s "at most one live error" note. The
   * SELECTION rule is tested for real in `feedback-refusal.test.ts`; this is the half that lives in
   * a file no test can execute, so it is pinned as text and labelled as such.
   */
  it('clears each form error when the other form starts submitting', () => {
    const detail = source('FeedbackDetail.svelte');
    expect(detail).toContain('onSubmit: () => { promoteForm.error = null; }');
    expect(detail).toContain('onSubmit: () => { triageForm.error = null; }');
  });

  /**
   * Both forms keep `reset: false`: a refusal must not blank what the operator has to resubmit.
   *
   * ⚠️ The pattern includes the neighbouring option ON PURPOSE. A bare `/reset: false/` counted
   * FIVE — the three prose mentions in this file's own 🔴 comments match it exactly as well as the
   * two option lines do, so the guard was measuring documentation. That is this whole file's failure
   * mode in miniature: a text pin cannot tell code from a sentence about the code.
   */
  it('keeps reset disabled on both forms', () => {
    const detail = source('FeedbackDetail.svelte');
    expect(detail.match(/reload: true, reset: false,/g)?.length).toBe(2);
  });
});

describe('opening a row goes through the one choke point', () => {
  /**
   * Two hrefs set `?open=`, and both must clear `?tab=`. `siblingHref` is the easier one to get
   * wrong because it builds its URL by hand — and it only renders ON the Issue tab, so a hand-rolled
   * version opens every sibling onto the one panel that shows none of what that reporter wrote.
   */
  it('routes both open-a-row hrefs through feedbackOpenHref', () => {
    expect(source('+page.svelte')).toContain('feedbackOpenHref(page.url,');
    expect(source('FeedbackPromote.svelte')).toContain('return feedbackOpenHref(next, id);');
  });

  it('never writes the open param by hand', () => {
    for (const file of ['+page.svelte', 'FeedbackPromote.svelte']) {
      expect(source(file)).not.toContain("searchParams.set('open'");
    }
  });
});

describe('round-1 defects that a simplify would reintroduce', () => {
  /**
   * `splitContext` deduplicates `images` among themselves; nothing compares `screenshotId` against
   * them, so a row where the reporter attached the file the capture produced holds the id twice and
   * `{#each … (item.id)}` THROWS — in production as well as dev — making that report permanently
   * unopenable. `feedback.test.ts` pins the precondition (ids are not unique); this pins the keying
   * that precondition makes necessary.
   */
  it('keys the attachment list by index', () => {
    expect(source('FeedbackAttachments.svelte')).toContain('{#each items as item, i (i)}');
  });

  /**
   * bits-ui declares `open` as `$bindable` and WRITES to it on Escape, overlay click and the close
   * button. A plain `open={…}` prop turns that write into a child-local override Svelte only
   * discards when the parent yields a different value, so a close the parent never sees leaves
   * `openIndex` set and re-clicking the same thumbnail does nothing.
   */
  it('controls the lightbox dialog with a function binding', () => {
    expect(componentSource('Lightbox.svelte')).toContain('bind:open={() =>');
  });
});
