import { readFileSync, readdirSync } from 'node:fs';
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
    expect(source('FeedbackDetail.svelte')).toContain("row.triageNote ?? ''");
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

  /**
   * 🔴 BOTH HALVES OF THE BINDING, because only the pair silences `ownership_invalid_mutation`.
   * `FeedbackPromote` mutates the draft, and Svelte's dev ownership validator looks for a SETTER on
   * the props descriptor (`svelte@5.56.3/src/internal/client/dev/ownership.js:71-80`) — `$bindable`
   * in the child is what declares the prop bindable, `bind:draft=` in the parent is what puts the
   * setter there. Dropping either one puts the warning back on every keystroke; measured this round
   * at 2 warnings for 2 keystrokes in a compiled repro of this shape, 0 with both.
   *
   * `let promoteDraft` rather than `const` is pinned alongside them because it is not a style
   * choice: `bind:` over a `const` is the compile error `constant_binding`, so a "tidy it back to
   * const" edit breaks the build — this assertion says why before anyone tries.
   *
   * ⚠️ THE PARENT HALF IS PINNED WITH ITS NEIGHBOURING ATTRIBUTE, not on `bind:draft={promoteDraft}`
   * alone, AND THAT IS NOT DECORATION. Written the short way this assertion SURVIVED its own
   * mutation: dropping the `bind:` from the template left it green, because `FeedbackDetail`'s
   * docstring SPELLS `bind:draft={promoteDraft}` while explaining why `const` is impossible, and a
   * text pin cannot tell code from a sentence about the code — the same trap the `reset: false`
   * comment below records. `form={promoteForm} bind:draft={promoteDraft} />` is element-shaped and
   * appears in no sentence; measured to kill the mutation that the short form let through.
   */
  it('binds the promote draft in both directions', () => {
    expect(source('FeedbackPromote.svelte')).toContain('draft = $bindable(),');
    const detail = source('FeedbackDetail.svelte');
    expect(detail).toContain('form={promoteForm} bind:draft={promoteDraft} />');
    expect(detail).toContain('let promoteDraft = $state(makeFeedbackPromoteDraft());');
  });
});

describe('the cross-clearing wiring', () => {
  /**
   * ⚠️ THIS BLOCK WAS TITLED "at most one refusal is live", AND THAT WAS THE RETRACTED CLAIM WEARING
   * A TEST NAME. Two refusals CAN be live — `feedback-refusal.ts` carries the reachable path — so
   * the wiring below is a narrowing, not an exclusion, and the SELECTION rule that has to be correct
   * when two are live is tested for real in `feedback-refusal.test.ts`. This is only the half that
   * lives in a file no test can execute, pinned as text and labelled as such.
   */
  it('clears each form error when the other form starts submitting', () => {
    const detail = source('FeedbackDetail.svelte');
    expect(detail).toContain('promoteForm.error = null;');
    expect(detail).toContain('onSubmit: () => { triageForm.error = null; }');
  });

  /**
   * The triage form captures what it POSTED so `onSuccess` can leave text typed in flight alone.
   * The decision itself is `reseedTriageNote`, tested for real in `feedback-drafts.test.ts`; this
   * pins that the panel still routes through it instead of re-seeding unconditionally.
   */
  it('re-seeds the note through reseedTriageNote, not unconditionally', () => {
    const detail = source('FeedbackDetail.svelte');
    expect(detail).toContain("note = reseedTriageNote(note, postedNote, row.triageNote ?? '');");
    expect(detail).toContain("postedNote = String(formData.get('note') ?? '');");
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

  /**
   * 🔴 THE TITLE THIS REPLACES CLAIMED MORE THAN ITS BODY CHECKED, and it was false in the very file
   * it scanned. It read "never writes the open param by hand" over a single
   * `not.toContain("searchParams.set('open'")` — one spelling — while `+page.svelte`'s pager writes
   * `urlWith(page.url, { cursor: …, open: null })` and `FeedbackFilters.svelte` writes
   * `next.searchParams.delete('open')`. Both are hand-written writes of the param; both passed.
   *
   * The property actually worth holding is narrower than the old title and wider than the old body:
   * CLEARING the param by hand is fine — a pager turn and a filter change both have to — but
   * SETTING it to an id must go through `feedbackOpenHref`, because that helper is the only thing
   * that also deletes `?tab=`, and a hand-rolled setter reopens the sticky-tab bug whose repro sits
   * in that helper's docstring.
   *
   * It scans the whole directory rather than a hardcoded pair, which is what makes a FUTURE third
   * site fail here instead of shipping — round 2 flagged that nothing stopped one, and a two-file
   * list is exactly how the EXISTING third site (`FeedbackFilters.svelte`) went unscanned.
   */
  it('sets the open param to an id only through feedbackOpenHref', () => {
    const files = readdirSync(feedbackDir).filter((file) => file.endsWith('.svelte'));
    expect(files.length).toBeGreaterThan(4);

    // Two spellings reach the param, and each needs its own witness — see the control below.
    const seen = { objectKey: [] as string[], searchParams: [] as string[] };
    const sets: string[] = [];
    for (const file of files) {
      const text = source(file);
      for (const match of text.matchAll(/\bopen:\s*([^,}]+)/g)) {
        seen.objectKey.push(`${file} — ${match[0]}`);
        if (match[1].trim() !== 'null') sets.push(`${file} — ${match[0]}`);
      }
      for (const match of text.matchAll(
        /searchParams\.(set|append|delete)\(\s*(?:'open'|FEEDBACK_OPEN_PARAM)/g
      )) {
        seen.searchParams.push(`${file} — ${match[0]}`);
        if (match[1] !== 'delete') sets.push(`${file} — ${match[0]}`);
      }
    }

    // 🔴 POSITIVE CONTROL, PER PATTERN — because `sets` being empty is the reassuring zero this
    // whole file is warned about, and a regex that matched nothing produces it just as readily as
    // clean code does. Both spellings have a live witness today (`+page.svelte`'s pager writes
    // `open: null`, `FeedbackFilters.svelte` writes `searchParams.delete('open')`), so each half of
    // the scan is proved able to match before the verdict is read.
    //
    // ⚠️ It counts WRITES, not CLEARS. An earlier draft of this control required two CLEARS, which
    // coupled it to how many sites happen to clear: turning one clear into a SET then reddened this
    // test through the control rather than through `sets` — a pass/fail for the wrong reason.
    // Measured, not reasoned about; that mutation now fails on the `sets` assertion.
    expect(seen.objectKey.length, 'no `open:` write found anywhere in the panel').toBeGreaterThan(
      0
    );
    expect(
      seen.searchParams.length,
      'no `searchParams.*(open)` write found anywhere in the panel'
    ).toBeGreaterThan(0);
    expect(sets).toEqual([]);
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
