import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FEEDBACK_PROMOTE_DRAFT_FIELDS } from '$lib/feedback-drafts';
import { FEEDBACK_SORT_COLUMNS } from '$lib/feedback-sort';
import { stripComments } from '../../test/strip-comments';

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
 * 🔴 THEY ARE WALKABLE BY REWORDING THE CODE, AND THAT IS INHERENT. A rewrite that is semantically
 * identical and textually different fails them; a rewrite that is textually identical and
 * semantically broken passes them. They can catch a DELETION or a "simplification" that removes a
 * construct. They cannot certify that the construct works — every one of these decisions was
 * originally verified by reading the library source, and that is still the only evidence behind them.
 *
 * ⚠️ ONE half of that IS fixed, and it is the half that actually bit us three rounds running: a pin
 * being satisfied by a COMMENT rather than by code. `source()` strips comments before scanning, so
 * every assertion below is a claim about code only. See `stripComments` and its two controls.
 *
 * Do not count these toward coverage of the panel. If a Svelte browser tier ever lands here, the
 * behavioural version of each of these replaces it rather than joining it.
 */

const dir = path.dirname(fileURLToPath(import.meta.url));
const feedbackDir = path.resolve(dir, '../../routes/feedback');

/**
 * 🔴 COMMENTS ARE REMOVED BEFORE ANYTHING IS SCANNED, AND THAT IS THE STRUCTURAL FIX FOR THIS FILE'S
 * ONE RECURRING DEFECT: a text pin cannot tell code from a sentence ABOUT the code, so a pin can be
 * satisfied by the very docstring that explains it and then survive deletion of what it names.
 *
 * It happened three times, each caught a round later than the last, and all three witnesses were in
 * `FeedbackDetail.svelte`'s own 🔴 comments: `reset: false` matched FIVE, three of them prose; a bare
 * `bind:draft={promoteDraft}` matched that file's docstring and stayed green with the `bind:` deleted
 * from the template; and `row.triageNote ?? ''` matched four times — two code, two prose — leaving
 * the re-seed pin green over a deleted re-seed. The first two were patched one at a time by widening
 * the string with a neighbouring token. That works and does not generalise: it fixes the instance and
 * leaves the class live for whichever pin is written next.
 *
 * Stripping comments closes the class instead. It is the ONE choke point every pin below goes
 * through, so it is also the one thing that has to be proved to work — see the two controls in
 * `the instrument itself`, which include a real-data one that watches the count MOVE.
 *
 * Order matters: a markup comment can contain either script-comment syntax, so markup goes first.
 * Over-stripping is the safe direction — it makes pins fail LOUDLY — which is why the line-comment
 * rule is allowed to be blunt (it spares `https://` and nothing else).
 *
 * `stripComments` lives in `src/test/strip-comments.ts`; the two controls below exercise it from
 * here, including the real-data one that watches the count MOVE.
 */

/**
 * Strip comments, then collapse runs of whitespace so an assertion survives reflowing and
 * reindentation, only.
 */
const source = (file: string): string =>
  stripComments(readFileSync(path.resolve(feedbackDir, file), 'utf-8')).replace(/\s+/g, ' ');

/** This page's own `$lib` modules — the URL builders the panel calls rather than open-coding. */
const libSource = (file: string): string =>
  stripComments(readFileSync(path.resolve(dir, '..', file), 'utf-8')).replace(/\s+/g, ' ');

const componentSource = (file: string): string =>
  stripComments(readFileSync(path.resolve(dir, '../components', file), 'utf-8')).replace(
    /\s+/g,
    ' '
  );

/** The per-report route's page, which renders the same panel the queue expands. */
const reportPageSource = (): string =>
  stripComments(readFileSync(path.resolve(feedbackDir, '[id]/+page.svelte'), 'utf-8')).replace(
    /\s+/g,
    ' '
  );

/** The unprocessed bytes, for the controls that compare against what stripping removed. */
const rawSource = (file: string): string =>
  readFileSync(path.resolve(feedbackDir, file), 'utf-8').replace(/\s+/g, ' ');

const count = (text: string, needle: string): number => text.split(needle).length - 1;

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
      'FeedbackContextPanel.svelte',
      'FeedbackBrowserErrors.svelte',
      '+page.svelte',
    ]) {
      expect(source(file).length).toBeGreaterThan(500);
    }
    expect(componentSource('Lightbox.svelte').length).toBeGreaterThan(500);
    expect(reportPageSource().length).toBeGreaterThan(500);
  });

  /**
   * 🔴 THE STRIPPER, BOTH DIRECTIONS, ON A SYNTHETIC FIXTURE. A stripper that removed nothing leaves
   * every pin below exactly as walkable as it was and says nothing about it; a stripper that removed
   * everything would make them all fail, which is loud. So the direction that has to be pinned is
   * REMOVAL — and it is pinned against a token that also appears in code, so "it deleted the whole
   * file" cannot pass as "it removed the comment".
   *
   * All three comment syntaxes these files actually use are covered: markup, block/JSDoc, and line.
   */
  it('removes a token from every comment syntax and keeps the one in code', () => {
    const fixture = [
      '<!-- a markup comment mentioning KEEPME and STRIPME -->',
      '<script lang="ts">',
      '  /** A JSDoc block mentioning STRIPME. */',
      '  /* A plain block mentioning STRIPME. */',
      '  // A line comment mentioning STRIPME.',
      '  const href = "https://example.test/STRIPME-is-not-here";',
      '  const KEEPME = 1;',
      '</script>',
    ].join('\n');

    const stripped = stripComments(fixture);

    expect(count(fixture, 'STRIPME')).toBe(5);
    // 4 of the 5 were in comments; the one inside the URL survives, which is what proves the `//`
    // rule did not eat the string it sits in.
    expect(count(stripped, 'STRIPME')).toBe(1);
    expect(stripped).toContain('https://example.test/STRIPME-is-not-here');
    expect(stripped).toContain('const KEEPME = 1;');
  });

  /**
   * 🔴 THE SAME CONTROL ON REAL DATA, because a stripper can pass a fixture written to suit it. This
   * one watches a NUMBER MOVE on the actual panel source: `reset: false` occurs five times in
   * `FeedbackDetail.svelte` — twice as an option, three times in prose explaining the option — and
   * `bind:draft={promoteDraft}` occurs twice, once in the template and once in a docstring. Both are
   * the exact witnesses that walked earlier rounds' pins.
   *
   * The raw side is asserted as "more than the stripped side" rather than as a literal count, so
   * rewording a docstring cannot redden it. If the prose witnesses are ever deleted outright this
   * control loses its subject and says so — repoint it at a live one rather than dropping it.
   */
  it('measurably removes prose from the real panel source, not just from a fixture', () => {
    const raw = rawSource('FeedbackDetail.svelte');
    const stripped = source('FeedbackDetail.svelte');

    for (const needle of ['reset: false', 'bind:draft={promoteDraft}']) {
      expect(
        count(raw, needle),
        `no prose witness for ${needle} left — this control can no longer observe stripping`
      ).toBeGreaterThan(count(stripped, needle));
    }

    // And what survives is exactly the code: two option lines, one template attribute.
    expect(count(stripped, 'reset: false')).toBe(2);
    expect(count(stripped, 'bind:draft={promoteDraft}')).toBe(1);
  });
});

describe('typed text outlives the reload every write issues', () => {
  /**
   * 🔴 THE TRIAGE NOTE BOX IS GONE, AND ITS COLUMN IS NOT. The status form posts no `note` field at
   * all, so a server reading an absent field as an empty one would blank `Feedback.triageNote` on
   * every status click. This pins the CLIENT half: the form must not acquire a note box again
   * without someone re-reading what the absent field now means.
   *
   * ⚠️ Measured: production holds 47 `Feedback` rows with `triageNote` non-null on ZERO of them, so
   * this guards the contract rather than existing text. The server half is behavioural and is tested
   * for real in `routes/feedback/__tests__/feedback-actions.test.ts` and against rows in
   * `lib/server/__tests__/feedback.service.test.ts`.
   */
  it('posts no note field from the status form', () => {
    const detail = source('FeedbackDetail.svelte');
    expect(detail).not.toContain('name="note"');
    expect(detail).not.toContain('row.triageNote');
  });

  /**
   * 🔴 THE CURRENT-STATUS BUTTON IS DISABLED, AND REMOVING THE NOTE BOX IS WHY. While this form
   * carried the textarea, `Save (<status>)` persisted the note without moving the row. With the note
   * gone it posts a status change to the status the row already has — `expectedStatus === status`,
   * so the UPDATE matches one row and `triageFeedback` reassigns `handledById` and `handledAt` to
   * whoever clicked, plus a `ModActivity` row. The queue's Handled column then credits a moderator
   * who only clicked through, over the one who actually ruled, and nothing records that it changed.
   *
   * Both halves: the guard is present, AND the label no longer says "Save" over a form with nothing
   * to save. A button that still read `Save (reviewed)` while disabled invites someone to re-enable
   * it rather than ask what it saves.
   */
  it('disables the button for the status the row already has', () => {
    const detail = source('FeedbackDetail.svelte');
    expect(detail).toContain('disabled={triageForm.submitting || status === row.status}');
    expect(detail).not.toContain('Save (');
  });

  /**
   * 🔴 THE TABS ARE GONE AND MUST NOT COME BACK BY THE BACK DOOR. The panel used to render one
   * section at a time behind `{#if activeTab === …}`, which DESTROYED the other sections' markup —
   * the reason every box below is bound to parent-owned state in the first place. A conditional
   * section reintroduces that without reintroducing anything that says so.
   *
   * ⚠️ "UNCONDITIONALLY" IS ABOUT MOUNTING, NOT ABOUT BEING ON SCREEN. The context block ships
   * inside a default-closed `<details>`, which hides its content and keeps it mounted — the next
   * test is the one that pins that distinction, and this one would pass just as happily over an
   * `{#if}` that unmounted it.
   */
  it('renders every section unconditionally', () => {
    const detail = source('FeedbackDetail.svelte');
    expect(detail).not.toContain('activeTab');
    expect(detail).toContain('<FeedbackAttachments {context} />');
    expect(detail).toContain('<FeedbackContextPanel');
    expect(detail).toContain('<FeedbackPromote');
  });

  /**
   * 🔴 THE CONTEXT BLOCK IS COLLAPSED, AND WHAT THIS PINS IS THE UNMOUNT — NOT THE CHEVRON. The
   * sibling test above forbids `{#if}` around a section because the tab strip's conditionals
   * DESTROYED the inactive sections' markup; a collapse is a conditional-shaped change, so it is
   * exactly the back door that test was written against. `<details>` HIDES its content and keeps it
   * mounted, which is the whole reason it is allowed here.
   *
   * 🔴 BOTH ASSERTIONS BELOW REPLACE ONES THAT READ AS COVERAGE AND PROVIDED NONE. Recorded rather
   * than quietly fixed, because the shapes that walked them are the shapes a maintainer writes:
   *
   *   - `toContain('<FeedbackContextPanel')` was supposed to pin the unmount. It does not: an
   *     `{#if contextOpen}` nested INSIDE the `<details>` and driven by `ontoggle` keeps that
   *     substring inside the extracted block, so the lazy-render this test exists to forbid passed
   *     37/37. The only `{#if}` it ever caught was one that also deleted `<details>` — which the
   *     count above already catches. The pin now reads the REGION between `</summary>` and
   *     `</details>` and forbids any `{#…}` block opener in it.
   *   - The default-closed pin was a regex requiring whitespace before `open`, so `bind:open=`
   *     matched nothing and a block shipping EXPANDED passed 37/37. A partial regex over a tag is
   *     satisfied by the inverted tag; the attribute NAMES are enumerated and compared as a set.
   *
   * 🔴 WHAT THE UNMOUNT PIN DOES NOT COVER, STATED EXACTLY, BECAUSE THIS IS THE ONE PARAGRAPH WHOSE
   * JOB IS SCOPE. The region runs from `</summary>` to `</details>`, so it covers the block's
   * descendants BELOW the summary and nothing else. Two things are outside it:
   *   - ANCESTORS — wrapping the whole `<details>` in `{#if …}` unmounts everything inside it and
   *     passes. That hole predates this guard. What makes it worth naming is that the badge below
   *     returns `null` when a report has no console errors and no failed requests, which makes
   *     "then hide the block entirely" the obvious next edit — and it would take the reconstructed
   *     URL, the filters, the session id and the Grafana link with it, on the ORDINARY report.
   *   - THE SUMMARY'S OWN DESCENDANTS — there is a live `{#if technicalSummary}` in there, which is
   *     exactly why the slice starts at `</summary>` rather than at the opening tag. Summary content
   *     is never hidden, so unmounting it costs nothing; a reader expecting "no `{#if}` anywhere
   *     inside `<details>`" would be wrong about the guard and about what it should assert.
   *
   * ⚠️ The class VALUES are deliberately not pinned — a Tailwind reorder changes them without
   * changing anything true. The attribute-name set is what carries the claim.
   */
  it('collapses the technical-details block with <details>, closed by default', () => {
    const detail = source('FeedbackDetail.svelte');

    // Exactly one, so every assertion below is about the block the reader has in mind. It doubles
    // as a `stripComments` tripwire: `FeedbackDetail.svelte`'s own comment names `<details>` in
    // prose, so a stripper that stopped working pushes this count above 1. How far above is
    // deliberately not written down — that is a property of prose nobody will keep in step.
    expect(count(detail, '<details')).toBe(1);

    const block = detail.match(/<details\b[^>]*>.*?<\/details>/)?.[0];
    // Positive control on the extraction: without it, a regex that stopped matching would make
    // every assertion below a claim about `undefined`.
    expect(block, 'no <details>…</details> block in FeedbackDetail.svelte').toBeDefined();

    // The summary carries the operator-specified title AND the badge. The badge is the only thing
    // that survives the collapse — without it, a report whose session threw forty console errors
    // looks exactly like a clean one at every level the operator can see. Its WORDING is asserted
    // behaviourally in `feedback-technical-summary.test.ts`; this only pins that it is rendered.
    const summary = block!.slice(block!.indexOf('<summary'), block!.indexOf('</summary>'));
    expect(summary, 'no <summary> in the <details> block').toContain('<summary');
    expect(summary).toContain('Technical details');
    expect(summary).toContain('{technicalSummary}');

    expect(block).toContain('<FeedbackContextPanel');

    // 🔴 THE UNMOUNT PIN. Everything the collapse hides must be mounted unconditionally, so the
    // region it wraps carries no block opener at all — `{#if}`, `{#each}`, `{#await}`, `{#key}`.
    const body = block!.slice(block!.indexOf('</summary>'));
    expect(body, 'the <details> body does not start at </summary>').toContain(
      '<FeedbackContextPanel'
    );
    expect(body).not.toMatch(/\{#\w+/);

    // 🔴 DEFAULT-CLOSED IS THE ABSENCE OF AN ATTRIBUTE, and `toContain('<details')` is satisfied by
    // every spelling that adds one. The tag is required to carry exactly one attribute, `class`,
    // with a literal value — so `open`, `bind:open`, `open={…}`, `{open}` and `{...spread}` all
    // fail, without pinning a single class value.
    const openTag = block!.match(/<details\b[^>]*>/)![0];

    // 🔴 THE BRACE CHECK IS NOT BELT-AND-BRACES — IT IS THE HALF THE NAME SCAN CANNOT SEE, AND THE
    // NAME SCAN'S OWN BLANKING STEP IS WHY. Quoted values are blanked so a Tailwind class list is
    // not read as attributes (`border-t` would be a name), and `{…}` is blanked with it — which
    // ERASES Svelte's shorthand `{open}`, an attribute spelled entirely inside braces and exactly
    // equivalent to `open={open}`. Measured: with only the name scan, `{open}` yielded `['class']`
    // and a block shipping EXPANDED passed 37/37 — the defect this assertion replaced, in a second
    // spelling, reintroduced by the fix for the first. No brace belongs in this tag at all, so the
    // cheap whole-token rule is also the correct one.
    expect(openTag).not.toContain('{');

    const attrNames = (tag: string): string[] =>
      [
        ...tag
          .replace(/"[^"]*"/g, '""')
          .replace(/\{[^}]*\}/g, '{}')
          .matchAll(/\s([A-Za-z_:][-\w:.]*)(?==|[\s/>])/g),
      ].map((m) => m[1]);

    // Instrument controls: both halves must be shown able to fire on the spellings they are trusted
    // against. A negative assertion over a matcher wired to nothing is green for the wrong reason.
    expect(attrNames('<details open class="x">')).toEqual(['open', 'class']);
    expect(attrNames('<details class="x" open>')).toEqual(['class', 'open']);
    expect(attrNames('<details class="x" bind:open={contextOpen}>')).toEqual([
      'class',
      'bind:open',
    ]);
    // The spelling the name scan is BLIND to, documented by exercising it: `{open}` yields only
    // `class`, so the name set alone would pass a tag that ships expanded. (No control is written
    // for the brace check itself — a literal asserted to contain a character visible in it cannot
    // fail and establishes nothing. What establishes it is the mutation run recorded in the commit.)
    expect(attrNames('<details class="x" {open}>')).toEqual(['class']);

    expect(attrNames(openTag)).toEqual(['class']);
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

  /** The mode toggle is draft state too: it must survive the reload a triage save issues. */
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
   * ⚠️ THE PARENT HALF IS PINNED WITH ITS NEIGHBOURING ATTRIBUTE, and the REASON HAS CHANGED — the
   * old one is history now, not mechanism. Written the short way this assertion once SURVIVED its
   * own mutation: dropping the `bind:` from the template left it green, because `FeedbackDetail`'s
   * docstring SPELLS `bind:draft={promoteDraft}` while explaining why `const` is impossible. That
   * route is closed at the source — `source()` strips comments, and the control above watches this
   * exact witness count drop from 2 to 1 — so the short form would now be code-only and sufficient.
   *
   * The long form is KEPT as defence in depth, on its own smaller merit: it pins the call SITE, so a
   * second `FeedbackPromote` rendered somewhere else without the binding is not covered by a pin
   * that only asks whether the string appears anywhere in the file.
   */
  it('binds the promote draft in both directions', () => {
    expect(source('FeedbackPromote.svelte')).toContain('draft = $bindable(),');
    const detail = source('FeedbackDetail.svelte');
    expect(detail).toContain('form={promoteForm} bind:draft={promoteDraft} />');
    expect(detail).toContain('let promoteDraft = $state(makeFeedbackPromoteDraft());');
  });
});

describe('the refusal banner sees which form the operator used last', () => {
  /**
   * 🔴 THE RANKING INPUT, AND IT IS THE HALF THAT LIVES IN A FILE NO TEST CAN EXECUTE. Two refusals
   * can be live at once — each form disables only its OWN submit control, so a status click followed
   * by a Create-issue click leaves two responses in flight — and `feedbackRefusal` breaks that tie
   * on `lastSubmitted`. A form that stops writing it is a form whose refusal can never outrank the
   * other's, which is precisely the defect that rule was written for. The SELECTION itself is tested
   * for real in `feedback-refusal.test.ts`; only the wiring is pinned here.
   *
   * ⚠️ THE CROSS-CLEARING IS STILL THERE, AND THIS SENTENCE USED TO SAY IT WAS "DELIBERATELY GONE".
   * It was removed once, that removal was reverted when it left a promote refusal on screen over a
   * triage save that SUCCEEDED, and the paragraph describing the removal survived the revert — so a
   * maintainer acting on it would have deleted a guard the very next test in this file pins by exact
   * string (`clears each form error when the other form starts submitting`). The two mechanisms are
   * complementary: cross-clearing collapses the common orderings, `lastSubmitted` decides the
   * interleaved one neither ordering rules out.
   */
  it('records which form submitted last, on both forms', () => {
    const detail = source('FeedbackDetail.svelte');
    expect(detail).toContain("lastSubmitted = 'triage';");
    expect(detail).toContain("lastSubmitted = 'promote';");
    expect(detail).toContain(
      'feedbackRefusal({ triage: triageForm.error, promote: promoteForm.error }, lastSubmitted)'
    );
  });

  /**
   * 🔴 THE CROSS-CLEARING IS WHAT STOPS A REFUSAL OUTLIVING WHAT IT REFUSED. It was deleted once in
   * this arc on the argument that `lastSubmitted` subsumed it, and that was wrong in a way no
   * typecheck sees: refuse a promote, then run a triage that SUCCEEDS, and `feedbackRefusal`'s
   * `?? raised[0]` fallback re-renders the promote refusal over a save that worked. There is no
   * success indicator on this panel to contradict it, so the red banner is the only thing on screen
   * and the operator's likeliest next move is to click the status button again.
   */
  /**
   * ⚠️ THE PAIRING IS PINNED INSIDE EACH HANDLER, AND THE SHORT FORM WAS WALKABLE. Asserting that
   * both strings appear ANYWHERE in the file is satisfied by each handler clearing its OWN error —
   * a plausible "simplification", the exact defect this guard names, and green. The title claimed a
   * RELATIONSHIP while the body inspected one side of it. Found by a delta audit of the fix that
   * restored this wiring, after a mutation sweep that only ever DELETED the two lines.
   */
  it('clears each form error when the other form starts submitting', () => {
    const detail = source('FeedbackDetail.svelte');
    expect(detail).toContain("lastSubmitted = 'triage'; promoteForm.error = null;");
    expect(detail).toContain("lastSubmitted = 'promote'; triageForm.error = null;");
  });

  /**
   * 🔴 THE PAGE-LEVEL REFUSAL IS A FALLBACK INSIDE THE ONE BANNER, NEVER A SECOND `ErrorAlert`.
   * `use:enhance` sets the page's `form` as well as `FormState.error`, so an unconditional
   * page-level alert on `/feedback/<id>` renders the same refusal twice — the defect this queue has
   * shipped three times, each invisible to every test, because this app has no browser tier.
   */
  it('renders the no-JS refusal only when neither form holds one', () => {
    const detail = source('FeedbackDetail.svelte');
    // 🔴 THE `lastSubmitted === null` GATE IS PART OF THE PIN. The page-level `form` is not replaced
    // until a response lands, so a bare `?? formError` re-renders the refusal an enhanced submit
    // just cleared, for the whole in-flight window.
    expect(detail).toContain('lastSubmitted) ?? (lastSubmitted === null ? formError : null)');
    expect(detail.match(/<ErrorAlert/g) ?? []).toHaveLength(1);

    const report = reportPageSource();
    expect(report).toContain('{formError}');
    expect(report).not.toContain('ErrorAlert');
  });

  /**
   * 🔴 THE PANEL MUST BE REBUILT WHEN THE REPORT CHANGES. SvelteKit reuses a route's component
   * across a param change, so `/feedback/12` → `/feedback/34` — Back/Forward, a URL edit, or one of
   * the sibling links `FeedbackPromote` now points at this route — would otherwise keep the same
   * `FeedbackDetail`: a refusal raised on report A reading as a refusal of B, and a half-written
   * issue draft submitting against B's id.
   */
  it('keys the panel on the report id on the per-report route', () => {
    // The panel must be INSIDE the key block — `{#key}` around anything else is a no-op that reads
    // as the guard.
    expect(reportPageSource()).toContain('{#key data.row.id} <FeedbackDetail');
  });

  /**
   * Both forms keep `reset: false`: a refusal must not blank what the operator has to resubmit.
   *
   * ⚠️ The pattern includes the neighbouring option, and — as with the `bind:draft` pin above — the
   * REASON HAS CHANGED. A bare `/reset: false/` once counted FIVE, because the three prose mentions
   * in `FeedbackDetail`'s own 🔴 comments match it exactly as well as the two option lines do, so the
   * guard was measuring documentation. `source()` now strips comments and that count is 2; the
   * control above asserts precisely this, on this file, so the claim is measured rather than argued.
   *
   * ⚠️ THE PAIR IS KEPT, AND ITS ORIGINAL REASON IS GONE RATHER THAN REPLACED. It used to read that
   * `reload: true` is what makes "the re-seed" read a fresh column — `reseedTriageNote` was deleted
   * in this PR along with the note box, so that sentence described nothing. What the pairing still
   * buys is narrower and worth stating plainly: `reload: true` is what re-renders the status badge,
   * the handled-by line and the issue link after a write, and a form that dropped it while keeping
   * `reset: false` would satisfy a bare `/reset: false/` pin while quietly showing stale data.
   */
  it('keeps reset disabled on both forms', () => {
    const detail = source('FeedbackDetail.svelte');
    expect(detail.match(/reload: true, reset: false,/g)?.length).toBe(2);
  });
});

describe('opening a row goes through the one choke point', () => {
  /** The queue's own expand/collapse link. `?open=` is meaningful only against the current view. */
  it('routes the queue expand link through feedbackOpenHref', () => {
    expect(source('+page.svelte')).toContain('feedbackOpenHref(page.url,');
  });

  /**
   * 🔴 A SIBLING LINK IS NOT AN `?open=` LINK, AND MAKING IT ONE IS THE BUG. A sibling is by
   * definition a report the operator did not navigate to, so it routinely sits outside the active
   * status filter or on an earlier keyset page — where `?open=` resolves to "not in this view" for a
   * row that plainly exists. This panel also renders on `/feedback/<id>`, where `?open=` is read by
   * nothing at all.
   */
  it('routes sibling links through the permanent per-report path', () => {
    const promote = source('FeedbackPromote.svelte');
    expect(promote).toContain('feedbackReportHref(id)');
    expect(promote).not.toContain('feedbackOpenHref');
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
   *
   * 🔴 AND IT SCANS THIS PAGE'S `$lib` MODULES TOO, because a directory scan stops covering a site
   * the moment that site is EXTRACTED. `feedbackNextPageHref` was moved out of `+page.svelte` into
   * `$lib/feedback-sort.ts` to make it testable, and a scan of `.svelte` files alone would have
   * silently stopped watching it — while also losing the `open:` witness the control below reads,
   * which would have reddened this test through its own instrument rather than through `sets`.
   *
   * ENUMERATED, NOT LISTED, for the reason the paragraph above gives about the `.svelte` half: a
   * hardcoded pair is how a third site goes unscanned. `feedback*.ts` in `$lib` is this page's whole
   * module family.
   *
   * 🔴 THE OBJECT-KEY PATTERN MATCHES THE COMPUTED SPELLING TOO, AND WIDENING THE SCAN IS WHAT MADE
   * THAT NECESSARY. `feedbackOpenHref` writes `{ [FEEDBACK_OPEN_PARAM]: id }`, which a bare
   * `/\bopen:/` cannot see. While the scan was `.svelte`-only that was merely "not a false
   * positive"; now that it covers `$lib/feedback*.ts`, the obvious way to add a SECOND `.ts` writer
   * is to copy the line out of the choke point — and the copy would have passed. So both spellings
   * are matched, and the choke point is excluded BY FILENAME rather than by being unmatchable,
   * which is the difference between a guard that is scoped and a guard that is blind.
   */
  const OPEN_CHOKE_POINT = 'feedback-open.ts';

  it('sets the open param to an id only through feedbackOpenHref', () => {
    const files = readdirSync(feedbackDir).filter((file) => file.endsWith('.svelte'));
    expect(files.length).toBeGreaterThan(4);
    const libFiles = readdirSync(path.resolve(dir, '..')).filter((file) =>
      /^feedback.*\.ts$/.test(file)
    );
    expect(libFiles.length).toBeGreaterThan(4);
    // The exclusion is only sound while the file it names exists to be excluded.
    expect(libFiles).toContain(OPEN_CHOKE_POINT);

    // Two spellings reach the param, and each needs its own witness — see the control below.
    const seen = { objectKey: [] as string[], searchParams: [] as string[] };
    const sets: string[] = [];
    for (const file of [...files, ...libFiles]) {
      if (file === OPEN_CHOKE_POINT) continue;
      const text = libFiles.includes(file) ? libSource(file) : source(file);
      for (const match of text.matchAll(/(?:\bopen:|\[FEEDBACK_OPEN_PARAM\]:)\s*([^,}]+)/g)) {
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
    // clean code does. Both spellings have a live witness today (`feedback-sort.ts`'s
    // `feedbackNextPageHref` writes `open: null`, `FeedbackFilters.svelte` writes
    // `searchParams.delete('open')`), so each half of the scan is proved able to match before the
    // verdict is read.
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

describe('the row click is an enhancement over a real link', () => {
  /**
   * 🔴 THE ANCHOR IS THE NO-JS SURFACE AND THE KEYBOARD AFFORDANCE BOTH, AND THE ROW CLICK IS WHY IT
   * LOOKS DELETABLE. Once every row responds to a click, the `Open`/`Close` cell reads as redundant
   * — and it is not: without JS it is the only way to reach the panel and the two forms inside it
   * (see `+page.svelte`'s `pageError`, which exists for exactly that client), and with a keyboard it
   * is the only thing in the tab order that opens a row.
   */
  it('keeps the Open/Close anchor beside the row handler', () => {
    const page = source('+page.svelte');
    expect(page).toContain('href={rowHref(row.id)}');
    expect(page).toContain("{open ? 'Close' : 'Open'}");
  });

  /**
   * 🔴 NO `tabindex` ON THE ROW. A focusable `<tr>` doing what the anchor inside it already does is
   * a second tab stop per row — 50 extra stops on a full page — for no capability the keyboard did
   * not have. The anchor is the affordance; this pins that nothing added a competing one.
   *
   * Positive control first: the scan must be able to see the attribute in the shape it would take.
   */
  it('adds no competing tab stop to the row', () => {
    const TABINDEX = /tabindex=/g;
    expect('<TableRow tabindex={0}>'.match(TABINDEX)).toHaveLength(1);
    expect(source('+page.svelte').match(TABINDEX) ?? []).toEqual([]);
  });

  /**
   * The handler has to be wired to the row at all. Everything it is HANDED is pinned by the
   * whole-expression assertion below.
   */
  it('wires the row click handler to every row', () => {
    expect(source('+page.svelte')).toContain('onclick={(event) => rowClick(event, row.id)}');
  });

  /**
   * 🔴 THE WHOLE CALL, AS ONE NORMALISED STRING, BECAUSE EVERY FIELD OF IT IS A SEAM AND FRAGMENTS
   * ARE WALKABLE. `+page.svelte` computes ten facts and `feedbackRowExpands` only receives them, so
   * every slot takes any expression of the right type: a cross-wiring typechecks, and this app has
   * no Svelte tier, so it is invisible to the suite as well. Two measured examples, both of which
   * left the full suite at 1229 passed / 0 failed and `svelte-check` at 0 errors:
   *   - `shiftKey: event.ctrlKey` — a shift-click then navigates the queue out from under the window
   *     the browser is opening.
   *   - `interactive: … && !target.closest(…)`, one `!` dropped so the sense inverts — every click
   *     reports as landing on a control, so NO row in the queue ever expands. This one also walked
   *     the fragment pin that used to live here: `target.closest(FEEDBACK_ROW_INTERACTIVE)` is a
   *     SUBSTRING of the inverted expression, so `toContain` went on matching.
   *
   * 🔴 SO IT IS `toBe` ON THE EXTRACTED CALL, NOT `toContain` ON THE FILE. A substring pin cannot
   * distinguish an expression from an expression that contains it; the whole normalised string
   * cannot be satisfied by an inversion, a cross-wiring, a reorder or an addition. The cost is that
   * a cosmetic edit — reordering the fields, renaming `target` — reddens this test and has to be
   * mirrored here. That is the trade: this object is the one place a silent queue-wide wedge can be
   * introduced with a green suite, and it has now happened twice.
   *
   * ⚠️ IT PINS SPELLING, NOT MEANING. It cannot tell you the ten facts are the RIGHT ten, only that
   * they are the ones reviewed. What each field has to be is argued at its own declaration in
   * `$lib/feedback-row-click.ts`; what the predicate DOES with them is tested for real in
   * `feedback-row-click.test.ts`.
   */
  it('hands the predicate exactly the reviewed ten facts', () => {
    const CALL = /feedbackRowExpands\(\{[^}]*\}\)/;

    // Positive control: the extraction must find the call. A regex that stopped matching would make
    // the comparison below a claim about `undefined`.
    const call = source('+page.svelte').match(CALL)?.[0];
    expect(call, 'the feedbackRowExpands call was not found in +page.svelte').toBeDefined();

    expect(call).toBe(
      'feedbackRowExpands({ button: event.button, ctrlKey: event.ctrlKey, ' +
        'metaKey: event.metaKey, shiftKey: event.shiftKey, altKey: event.altKey, ' +
        'defaultPrevented: event.defaultPrevented, interactive: target instanceof Element && ' +
        '!!target.closest(FEEDBACK_ROW_INTERACTIVE), ' +
        "selection: window.getSelection()?.toString() ?? '', " +
        'openPanelDirty: data.openVisible && panelDirty, alreadyOpen: data.open === id, })'
    );
  });

  /**
   * 🔴 THE HANDLER OPENS; ONLY THE ANCHOR TOGGLES. `rowHref` is a toggle, so routing the row click
   * through it makes the whole nine-cell strip a close target — and closing destroys the panel and
   * every unsaved character of the issue draft inside it. `feedbackRowExpands`' dirtiness guard is
   * the other half; this pins that the navigation itself cannot close a row.
   *
   * ⚠️ WHAT THIS PINS IS THE NAVIGATION, AND ONLY THAT. The argument object it used to carry field
   * pins for is pinned whole, above — including `openPanelDirty` and `alreadyOpen`, which had the
   * only two field pins this file ever had. The sentence that replaced them claimed every field was
   * pinned when 2 of 10 were, and carved the other eight out as safe because they "read straight off
   * the `MouseEvent`", which was wrong twice over: `selection` reads `window.getSelection()` and
   * `interactive` is a `closest()` DOM read, and a cross-wiring between two same-typed event fields
   * typechecks regardless.
   */
  it('navigates the row click through the open-only href', () => {
    expect(source('+page.svelte')).toContain(
      'goto(feedbackOpenHref(page.url, id), { noScroll: true, keepFocus: true })'
    );
  });

  /**
   * 🔴 THE DIRTY SIGNAL HAS TO ACTUALLY LEAVE THE PANEL, and it crosses a seam no typecheck walks:
   * `FeedbackDetail` derives it, `+page.svelte` decides with it, and a `bind:` dropped at the call
   * site leaves the page reading a `panelDirty` that is false forever. The row click would then go
   * back to discarding unsaved issue drafts — silently, and only for an operator mid-sentence.
   *
   * Both ends are pinned, because either alone is satisfiable without the other: `$bindable` in the
   * child declares the prop bindable, `bind:draftDirty=` in the parent puts the setter there, and
   * the effect is what keeps the value in step with the draft.
   */
  it('reports the draft dirtiness out of the panel and into the queue', () => {
    const detail = source('FeedbackDetail.svelte');
    expect(detail).toContain('draftDirty = $bindable(false),');
    // 🔴 `feedbackPanelHasUnsavedDraft(row, …)`, NOT the bare dirty check. The row half is what
    // stops a SUCCESSFUL promote wedging the queue: it sets `bugId`, `FeedbackPromote` swaps to its
    // linked-issue view and every box unmounts, but the draft object survives in this component —
    // so the bare check goes on reporting the text of a form nobody can see, and every row click in
    // the queue does nothing for the life of the page.
    expect(detail).toContain('draftDirty = feedbackPanelHasUnsavedDraft(row, promoteDraft);');
    expect(source('+page.svelte')).toContain('bind:draftDirty={panelDirty}');
  });

  /**
   * ⚠️ THE PER-REPORT PAGE DELIBERATELY DOES NOT BIND IT. That route has no rows to click, so there
   * is nothing for the flag to protect — and a binding there would be a second writer of a fact
   * only the queue reads.
   */
  it('does not bind the dirty signal on the per-report route', () => {
    expect(reportPageSource()).not.toContain('draftDirty');
  });

  /**
   * The anchor's navigation options have to match the handler's, and nothing makes them: `rowHref`
   * settles the URL only. Dropping either attribute sends the operator back to the top of the queue,
   * or a keyboard operator back to the top of the document, on a gesture whose whole point is that
   * the panel opens in place.
   */
  it('keeps the anchor and the handler agreeing on scroll and focus', () => {
    const page = source('+page.svelte');
    expect(page).toContain('data-sveltekit-noscroll');
    expect(page).toContain('data-sveltekit-keepfocus');
    // `replacestate` is deliberately NOT on this anchor — closing a row with Back is worth a
    // history entry, unlike a sort cycle. Pinned so re-adding it has to come past this line.
    expect(page).not.toContain('data-sveltekit-replacestate');
  });
});

describe('the queue is ordered by the server, never by the browser', () => {
  /**
   * The header row is data-driven; the two `colspan`s that have to match it are not, and a literal
   * that disagrees leaves the detail panel and the empty-state row a cell short. Nothing can observe
   * that — this app has no Svelte test tier — so the pin is on the SPELLING, which is the only thing
   * a text scan can hold.
   *
   * ⚠️ READ THE TITLE NARROWLY: this does NOT verify that every colspan is derived, it verifies that
   * `+page.svelte` contains exactly two `colspan={COLUMNS.length}` and no `colspan={<digits>}`. A
   * `colspan="9"` string attribute — valid Svelte and idiomatic HTML — walks straight past it, and
   * so does `colspan={ 9 }`. It also reddens on a CORRECTLY written third colspan, because the count
   * is pinned. Both are accepted: a pin that has to be re-read when the table grows is the cost of
   * having any pin at all here.
   */
  it('derives every colspan from COLUMNS rather than spelling a number', () => {
    const page = source('+page.svelte');
    const LITERAL_COLSPAN = /colspan=\{\d+\}/g;

    // Positive control: the scan must be able to see a literal, in the exact shape one would take.
    expect('<TableCell colspan={9} class="x">'.match(LITERAL_COLSPAN)).toHaveLength(1);

    expect(page.match(/colspan=\{COLUMNS\.length\}/g) ?? []).toHaveLength(2);
    expect(page.match(LITERAL_COLSPAN) ?? []).toEqual([]);
  });

  /**
   * 🔴 THE THREE NAVIGATION MODIFIERS ARE WHAT MAKE A LINK BEHAVE LIKE AN IN-PLACE CONTROL, and
   * dropping one costs nothing visible in review — the header still works, it just misbehaves.
   * Without `noscroll` a sort click throws the operator back to the top of the queue, away from the
   * row they have open; without `keepfocus` a keyboard operator is dropped to the top of the
   * document, so cycling asc→desc→none means re-tabbing to the header three times; without
   * `replacestate` those three clicks leave three history entries and Back stops leaving the page.
   *
   * ⚠️ `FeedbackTabs.svelte` used to be pinned alongside it and no longer exists. The tab strip was
   * the page's second link-driven control; the sort header is the only one left.
   */
  it('keeps the navigation modifiers on the sort header', () => {
    const text = source('FeedbackSortHeader.svelte');
    for (const attribute of [
      'data-sveltekit-noscroll',
      'data-sveltekit-replacestate',
      'data-sveltekit-keepfocus',
    ])
      expect(text, `FeedbackSortHeader.svelte dropped ${attribute}`).toContain(attribute);
  });

  /**
   * 🔴 A LEDGER OVER THE SEAM NOBODY OWNS: the column set exists in TWO shapes that nothing links.
   * `FEEDBACK_SORT_COLUMNS` decides which `?sort=` values the server honours; `COLUMNS` in
   * `+page.svelte` decides which headers an operator can click. `satisfies` ties the union to the
   * SQL map in the service and says nothing about the table, so a seventh column is URL-sortable
   * with no way to reach it — and a column REMOVED from the union leaves a header that produces a
   * link the server ignores. Both are silent.
   *
   * Fails when the set GROWS or SHRINKS, which is why it is an equality over sorted lists rather
   * than a containment check in either direction.
   */
  it('gives every server-sortable column a header, and no header a column the server refuses', () => {
    const page = source('+page.svelte');
    const declared = [...page.matchAll(/sortable: '([^']+)'/g)].map((m) => m[1]);

    // Instrument: a regex that stopped matching would make the comparison a claim about nothing.
    expect(declared.length, 'no `sortable:` column found in +page.svelte').toBeGreaterThan(0);
    expect([...declared].sort()).toEqual([...FEEDBACK_SORT_COLUMNS].sort());
  });

  /**
   * 🔴 A CLIENT-SIDE SORT IS THE SILENTLY-WRONG ANSWER HERE, AND IT IS THE OBVIOUS ONE. The list is
   * keyset-paged at `FEEDBACK_PAGE_SIZE`, so `[...data.items].sort(…)` orders the 50 rows that
   * happen to be loaded and presents them as an ordering of the queue: the arrow points the right
   * way, the visible rows are in order, and it is wrong for every queue past its first page. With 26
   * live rows it is not merely hard to spot — it is INDISTINGUISHABLE from the correct
   * implementation on every query anyone can run today. The ordering lives in `getFeedbackList`, and
   * `lib/server/__tests__/feedback-sort.pglite.test.ts` is where it is proved across a boundary.
   *
   * Scoped to `+page.svelte` because that is the only file with `data.items` in scope — the queue
   * exists nowhere else. The directory-wide form is not narrower or wider, it is a DIFFERENT claim:
   * no `.sort()` anywhere in the panel. That would be walkable into a false positive by a sibling
   * ordering something of its own (attachments, siblings, context keys), and a guard that reddens
   * for the wrong reason is one people learn to click through. ⚠️ No such call exists today, so
   * this is a choice about what the pin MEANS, not a report of a witness.
   */
  it('renders data.items in the order the server returned them', () => {
    const page = source('+page.svelte');

    // The each-block is what renders the queue; pin that it reads `data.items` directly, so a
    // reordered local copy would have to change this line to be used at all.
    expect(page).toContain('{#each data.items as row (row.id)}');

    // 🔴 POSITIVE CONTROL. `not.toContain` over an empty string passes, and so does a pattern that
    // cannot match the spelling anyone would actually write. Feed the scan a planted sort — in the
    // exact shape this component would use — and watch it match before reading the verdict.
    const REORDERS = /\.(sort|toSorted|reverse|toReversed)\s*\(/g;
    const planted = 'const rows = [...data.items].sort((a, b) => (a.area < b.area ? -1 : 1));';
    expect(planted.match(REORDERS)).toHaveLength(1);

    expect(page.match(REORDERS) ?? []).toEqual([]);
  });
});

/**
 * The browser-error snapshot's renderer.
 *
 * The SHAPE routing is tested for real in `feedback.test.ts` (`splitContext`). What can only be
 * pinned as text is the property that makes carrying hostile strings safe in the first place:
 * the panel renders them as TEXT and never as a URL.
 */
describe('the browser-error snapshot renders as text, never as a request', () => {
  /**
   * 🔴 THE LEDGER, AND IT IS THE LOAD-BEARING ONE IN THIS BLOCK. `networkErrors[].url` is a
   * client-supplied string that LOOKS like it wants to be a link, sitting in the same panel whose
   * sibling field already needed `IMAGE_KEY` because `getEdgeUrl` returns an `http`-prefixed
   * argument verbatim into a moderator's `<img src>` — an outbound request that hands the reporter
   * a read receipt naming who opened their report and when.
   *
   * It counts request-making attributes over the WHOLE file rather than matching a spelling near
   * the new fields, because a spelled guard is walkable: `{@const u = entry.url}` followed by
   * `href={u}` defeats any pattern keyed on the identifier, and defeats nothing keyed on the
   * COUNT. Two `href`s exist today — the reconstructed page link and the Grafana link, both built
   * from values that are not reporter free text — so a THIRD fails here whatever it is named, and
   * whoever adds it has to come and say why.
   *
   * `EdgeImage` is pinned at zero rather than omitted: it is the component that wraps `getEdgeUrl`,
   * it USED to be imported by this file, and re-adding it is the specific mistake this guards.
   * Note the stripped-vs-raw pair below — `EdgeImage` appears once in the panel's own prose, which
   * is exactly the comment-satisfies-a-pin trap this file's `stripComments` exists to close, and
   * it is asserted here as a live witness that stripping is working on THIS file.
   */
  it('adds no href, src or EdgeImage to the panel', () => {
    // 🔴 THE LEDGER IS SCOPED TO A FILE LIST, NOT TO ONE FILE, AND THAT IS NOT TIDINESS. Both
    // surviving `href=`s live in the FIRST section (the reconstructed page link and the Grafana
    // link). So moving the snapshot sections into a sibling component — which this directory's own
    // precedent invites, `FeedbackAttachments.svelte` being exactly that — would leave this
    // assertion reading `2` and PASSING, while `{entry.url}`, the one reporter-chosen string in
    // this panel that looks like it wants to be a link, moved to a file nothing scans. The count
    // is what defeats a renamed variable; the file list is what defeats a moved file.
    //
    // An explicit list, deliberately NOT `readdirSync(feedbackDir)` the way the open-param scan
    // does it: `+page.svelte` and `FeedbackDetail.svelte` legitimately carry `href=`, so a
    // directory scan would turn this into noise. Add a file here when the markup moves.
    const REQUEST_FREE_FILES = ['FeedbackContextPanel.svelte', 'FeedbackBrowserErrors.svelte'];
    const combined = REQUEST_FREE_FILES.map(source).join('\n');

    // Positive control, PER FILE: the scan CAN match and every file in the list is really read. A
    // zero from a broken read is indistinguishable from a zero from clean code, and every
    // assertion below is a zero or a small number.
    for (const file of REQUEST_FREE_FILES) {
      expect(source(file).length, `${file} read as empty or trivial`).toBeGreaterThan(500);
    }
    expect(count(combined, 'href=')).toBeGreaterThan(0);

    expect(count(combined, 'href=')).toBe(2);
    expect(count(combined, 'src=')).toBe(0);
    expect(count(combined, 'EdgeImage')).toBe(0);

    // 🔴 THE STRIPPER, WITNESSED ON THIS FILE. `EdgeImage` is named once in the panel's own 🔴
    // comment explaining why it must not come back. If the raw count ever equals the stripped one,
    // that witness is gone and the `toBe(0)` above has quietly become a claim about prose.
    expect(
      REQUEST_FREE_FILES.reduce((n, file) => n + count(rawSource(file), 'EdgeImage'), 0),
      'no prose witness for EdgeImage left — this control can no longer observe stripping'
    ).toBeGreaterThan(count(combined, 'EdgeImage'));
  });

  /**
   * Both lists are keyed by INDEX, for the reason `FeedbackAttachments.svelte` is: `{#each … (k)}`
   * THROWS on a duplicate key in production as well as in dev, and both arrays are client-supplied
   * with no uniqueness constraint. The same console line twice in a row is the ORDINARY case, so a
   * value key would make a looping report permanently unopenable — the exact defect that already
   * shipped once on the attachment list.
   */
  it('keys both snapshot lists by index', () => {
    const errors = source('FeedbackBrowserErrors.svelte');
    expect(errors).toContain('{#each context.consoleErrors as entry, i (i)}');
    expect(errors).toContain('{#each context.networkErrors as entry, i (i)}');
  });

  /**
   * 🔴 THE REPEAT COUNT MUST REACH THE SCREEN, AND ITS FAILURE MODE IS SILENT. The producer
   * collapses a React cascade's forty identical messages into ONE entry carrying `count: 40`. A
   * panel that renders only `entry.message` shows that as a single line indistinguishable from an
   * error that fired once — so the collapse would have made the queue LESS informative than the
   * buffer it replaced, with every test still green because `splitContext` carries the field
   * faithfully and nothing downstream reads it.
   *
   * Asserted on the template text for the reason the rest of this file is: this app has no Svelte
   * render harness, so the source is the only place the binding can be observed.
   */
  it('renders the repeat count next to a console message', () => {
    const errors = source('FeedbackBrowserErrors.svelte');
    expect(errors).toContain('{entry.message}');
    expect(errors).toContain('×{entry.count}');
  });

  /**
   * And only above 1. A `×1` on every single-occurrence line is noise that trains the eye past the
   * badge, which is the one place a cascade announces itself — so the conditional is the feature,
   * not an optimisation, and an unconditional render would pass the assertion above on its own.
   */
  it('shows the count only when a message actually repeated', () => {
    expect(source('FeedbackBrowserErrors.svelte')).toContain('{#if entry.count > 1}');
  });

  /**
   * Each section is gated on its own `.length`, so a row with neither renders neither heading.
   * `splitContext` yields `[]` for absent AND for empty, so "no section" is the correct output for
   * both — an empty "Console errors" heading would read as "we looked and there were none", which
   * is a different and unsupported claim.
   */
  it('renders each section only when it has entries', () => {
    const errors = source('FeedbackBrowserErrors.svelte');
    expect(errors).toContain('{#if context.consoleErrors.length}');
    expect(errors).toContain('{#if context.networkErrors.length}');
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
