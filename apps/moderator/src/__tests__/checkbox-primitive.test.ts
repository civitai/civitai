import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../test/strip-comments';
import { hasAttr, tagsNamed, tokenizeTags, walkTags } from '../test/svelte-tags';

/**
 * ⚠️ A TEXT PIN OVER MARKUP. Nothing renders; nothing is clicked; no FormData is ever built.
 *
 * Two invariants, and the second is the one with teeth:
 *
 *   (1) No raw `<input type="checkbox">` survives in this app. A raw input takes no theme, and — the
 *       reason it is worth a test rather than a lint — carries NO hit area at all, so it is 16 CSS px
 *       on a touch screen with nothing the coarse-pointer floor can grow.
 *   (2) Each bulk form field has exactly ONE writer. Every consumer of these reads
 *       `form.getAll(<name>)`, so a second element spelling the same `name` does not overwrite the
 *       first — it APPENDS. The failure is silent and it is a moderation action against the wrong set:
 *       a `name` left on a control whose hidden input the primitive also renders would post every id
 *       twice, and a Delete's confirmed count would no longer be the payload's length.
 *
 * 🔴 SOURCE IS COMMENT-STRIPPED FIRST. Several of the files below explain in prose exactly what these
 * pins look for; without the strip a pin passes on its own witness and keeps passing after the code is
 * deleted. `src/test/strip-comments.ts` records the three incidents that established this.
 */

const dir = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(dir, '..');

function svelteFiles(from: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const full = path.join(from, entry.name);
    if (entry.isDirectory()) out.push(...svelteFiles(full));
    else if (entry.name.endsWith('.svelte')) out.push(full);
  }
  return out;
}

const files = svelteFiles(SRC).sort();
const source = new Map(
  files.map((f) => [path.relative(SRC, f), stripComments(readFileSync(f, 'utf8'))])
);

/**
 * A raw checkbox input, tolerating attributes in any order and across newlines — five of the six this
 * change removed were single-line and one was not, so a line-anchored pattern would have reported the
 * app clean while `ImageActionBar` still held one.
 */
const RAW_CHECKBOX = /<input\b[^>]*\btype=(["'])checkbox\1/;

const read = (file: string) => {
  const text = source.get(file);
  if (text === undefined) throw new Error(`${file} is not in the scanned corpus`);
  return text;
};

const CHECKBOXES = ['Checkbox', 'SelectionCheckbox'] as const;

/** Every checkbox opening tag in `text`. */
const checkboxTags = (text: string) => tagsNamed(text, ...CHECKBOXES);

/**
 * Every checkbox with NO `data-touch-target` ancestor, as its opening tag.
 *
 * Ancestry, not a count or a proximity window: the CSS selector is
 * `[data-touch-target] [data-slot='checkbox']::after`, a descendant combinator, so anything weaker
 * passes while the pair is broken. An earlier version of this counted markers per file and a mutant
 * that deleted the marker from ImageActionBar's strike row SURVIVED, because the two on its
 * Remove/Cancel buttons still cleared the count.
 */
function unmarkedCheckboxes(text: string): string[] {
  const unmarked: string[] = [];
  walkTags(text, (tag, ancestors) => {
    if (!CHECKBOXES.includes(tag.name as (typeof CHECKBOXES)[number])) return;
    if (!ancestors.some((a) => hasAttr(a, 'data-touch-target'))) unmarked.push(tag.raw);
  });
  return unmarked;
}

/**
 * Every element whose `name=` matches, as its whole opening tag. `spelling` is matched against the
 * attribute VALUE as written — a quoted literal for most fields, `{field}` where the name is a prop.
 */
function writersOf(text: string, spelling: string): string[] {
  const escaped = spelling.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const value = spelling.startsWith('{') ? escaped : `(["'])${escaped}\\1`;
  const matcher = new RegExp(`\\bname=${value}`);
  return tokenizeTags(text)
    .filter((t) => !t.closing && matcher.test(t.attrs))
    .map((t) => t.raw);
}

describe('the checkbox corpus', () => {
  // Positive control, in both directions. A scanner that walked the wrong directory, or a pattern that
  // can never match, would make the sweep below a reassuring zero indistinguishable from a probe wired
  // to nothing.
  it('scans a real corpus with a pattern that can fire', () => {
    expect(files.length).toBeGreaterThan(150);
    expect(RAW_CHECKBOX.test('<input type="checkbox" name="x" />')).toBe(true);
    expect(RAW_CHECKBOX.test('<input\n  type="checkbox"\n  name="x"\n/>')).toBe(true);
    // Must not fire on the things it is NOT about, or the sweep's zero says nothing.
    expect(RAW_CHECKBOX.test('<input type="hidden" name="reviewIds" />')).toBe(false);
    expect(RAW_CHECKBOX.test('<Checkbox name="removeMedia" value="true" />')).toBe(false);
  });

  it('holds no raw checkbox inputs anywhere in THIS app', () => {
    // Zero, not a ledger: an exhaustive sweep of `apps/moderator` found six and this change removed
    // all six, so any reappearance is a regression rather than a pre-existing exception to record.
    //
    // ⚠️ The scope is this app, and the zero is not a claim about the repo. Six raw checkbox inputs
    // survive outside it — `apps/auth/src/routes/admin/spoke-domains/+page.svelte` (4),
    // `apps/auth/src/routes/login/oauth/authorize/+page.svelte` (1), and
    // `apps/creator-studio/src/lib/components/monetization/RightsAffirmation.svelte` (1). `apps/auth`
    // predates `@civitai/ui` wholesale and is deliberately out of scope; the creator-studio one gates
    // a rights affirmation on a monetization form and is the likeliest second consumer of the floor.
    expect(
      [...source].filter(([, text]) => RAW_CHECKBOX.test(text)).map(([file]) => file),
      'raw <input type="checkbox"> is 16px with no hit area on touch. Use `Checkbox` from ' +
        '@civitai/ui (or `SelectionCheckbox` for a multi-select list) and mark its row ' +
        '`data-touch-target` where the action is destructive.'
    ).toEqual([]);
  });
});

describe('bulk form fields have exactly one writer', () => {
  // Field -> the file that must post it. Asserted as a LEDGER: it fails when the set of writers grows
  // (a duplicate payload) and when it shrinks (the field stops posting and the action silently becomes
  // a no-op over an empty list). Either direction is a moderation action against the wrong set.
  const FIELDS: [file: string, field: string][] = [
    ['routes/retool/user-lookup/ReviewsPanel.svelte', 'reviewIds'],
    ['routes/retool/user-lookup/IdentityPanel.svelte', 'fields'],
    // Spelled as a prop, not a literal — see the dedicated case below for why that row is not enough.
    ['routes/retool/user-lookup/CommentList.svelte', '{field}'],
    ['lib/components/ImageActionBar.svelte', 'strikeOwners'],
    ['routes/retool/bulk-ban/+page.svelte', 'removeMedia'],
    ['routes/retool/bulk-ban/+page.svelte', 'removeComments'],
  ];

  it.each(FIELDS)('%s posts `%s` from exactly one element', (file, field) => {
    expect(writersOf(read(file), field)).toHaveLength(1);
  });

  it('CommentList’s interpolated name still resolves to the fields the action reads', () => {
    // The ledger row above can only see that ONE element writes `name={field}` — not what `field` is.
    // Pinning the prop's type is what keeps that row meaningful: renamed to something
    // `contentAction` does not read, the row would still pass while every comment bulk action became
    // a silent no-op over an empty `form.getAll(...)`.
    expect(read('routes/retool/user-lookup/CommentList.svelte')).toContain(
      "field: 'commentIds' | 'commentV2Ids'"
    );
  });

  it('ReviewsPanel posts reviewIds from a hidden input driven by the selection, not by a checkbox', () => {
    const text = read('routes/retool/user-lookup/ReviewsPanel.svelte');

    // The single writer must be a hidden input. A `name` on the control instead would work — the
    // primitive renders its own hidden input — but would tie the payload to what is RENDERED, which is
    // the defect this replaced: a ticked row filtered away, or paged past `limit`, stopped posting.
    const [writer] = writersOf(text, 'reviewIds');
    expect(writer).toMatch(/<input\b/);
    expect(writer).toMatch(/\btype="hidden"/);
    expect(text).toMatch(/\{#each posting as id \(id\)\}/);

    // 🔴 And the control must NOT also carry a name, or bits-ui's hidden input appends a second entry
    // per ticked row and `form.getAll('reviewIds')` returns double.
    const [checkbox, ...rest] = tagsNamed(text, 'SelectionCheckbox');
    expect(rest).toEqual([]);
    expect(checkbox).toBeTruthy();
    expect(checkbox.raw).not.toMatch(/\bname=/);
  });

  it('posts the RENDERED rows: one list feeds the payload and the {#each}', () => {
    // 🔴 The review's highest-severity finding, and the reason this pin reads two identifiers rather
    // than one spelling. `posting` was derived from `written` (the whole filtered list) while the rows
    // rendered from `written.slice(0, limit)`. `ListCard`'s limit SHRINKS as well as grows ("Show
    // less"), and it is component-local `$state` that resets when the `{#await}` re-enters its pending
    // branch on reload — so a review ticked at position 30 and then collapsed out of view kept posting,
    // with Exclude/Include carrying no confirmation to catch it. Under the old `bind:group` that row's
    // input had unmounted and did NOT post, so this was a regression in blast radius.
    //
    // Pinning the RELATIONSHIP — same identifier both sides — rather than the word `visible`, which a
    // rename would walk straight through.
    const text = read('routes/retool/user-lookup/ReviewsPanel.svelte');
    const payloadList = text.match(/\{@const posting = postedIds\(\s*(\w+)\s*,/)?.[1];
    const renderedList = text.match(/\{#each (\w+) as r \(r\.id\)\}/)?.[1];
    expect(payloadList, 'cannot read the list `posting` is derived from').toBeTruthy();
    expect(renderedList, 'cannot read the list the rows render from').toBeTruthy();
    expect(
      payloadList,
      `\`posting\` is derived from \`${payloadList}\` but the rows render from \`${renderedList}\`. ` +
        'A selection can then post rows that are not on screen.'
    ).toBe(renderedList);
  });

  it('clears the selection once a write lands', () => {
    // Exclude/Include leave their rows in the list, so without this the ticks survive into the next
    // action's payload. `CommentList.svelte` does the same in its own onSuccess.
    expect(read('routes/retool/user-lookup/ReviewsPanel.svelte')).toMatch(
      /onSuccess:[\s\S]{0,200}?selectedReviews\.clear\(\)/
    );
  });

  it('the count an operator confirms is the payload, not the raw selection', () => {
    // These two were different quantities before: `selectedReviews.length` counted rows that had been
    // filtered off screen and were no longer posting. One derivation now feeds both.
    const text = read('routes/retool/user-lookup/ReviewsPanel.svelte');
    expect(text).toMatch(/\{@const posting = postedIds\(/);
    expect(text).toMatch(/count=\{posting\.length\}/);
    expect(text).not.toMatch(/count=\{selectedReviews/);
  });
});

describe('destructive surfaces carry the touch-target marker', () => {
  // The seam this guards: the floor lives in `global.css` keyed on `data-touch-target`, and the markup
  // that opts in lives in six other files. Each side is individually unremarkable and neither test
  // above nor `touch-targets.test.ts` can see the pair come apart — a marker deleted here leaves the
  // CSS valid, matching nothing, and passing its own suite.
  const MARKED = [
    'lib/components/BanConfirmForm.svelte',
    'lib/components/ConfirmSubmit.svelte',
    'lib/components/ImageActionBar.svelte',
    'routes/audit/training-data/[versionId]/CsamReportForm.svelte',
    // The "reviewed it another way" tick that unlocks Approve on a dataset this app cannot preview.
    'routes/audit/training-data/workflow/[workflowId]/WorkflowReviewActions.svelte',
    'routes/retool/bulk-ban/+page.svelte',
    'routes/retool/user-lookup/CommentList.svelte',
    'routes/retool/user-lookup/IdentityPanel.svelte',
    'routes/retool/user-lookup/ReviewsPanel.svelte',
  ];

  it('is exactly the declared set of files', () => {
    expect(
      [...source].filter(([, text]) => text.includes('data-touch-target')).map(([file]) => file),
      'the set of files opting into the coarse-pointer floor changed. Growing it is usually right — ' +
        'add the file here. Shrinking it means a destructive control lost its floor.'
    ).toEqual(MARKED);
  });

  it('puts the marker on an ANCESTOR of every checkbox, not merely somewhere in the file', () => {
    // 🔴 This assertion started life as "the file marks at least as many rows as it has checkboxes",
    // which read as coverage and provided none: deleting the marker from ImageActionBar's strike row
    // left the two on its Remove/Cancel buttons, so the count still cleared and the mutant SURVIVED.
    // The relationship is ancestry, so ancestry is what has to be walked.
    // Scoped to the marked surfaces. Checkboxes elsewhere in this app are ordinary filters and
    // select-alls, deliberately left at the primitive default — a blanket floor over the moderation
    // lists would widen every row under touch, which is what the three preceding responsive PRs
    // were removing.
    const checkboxes = MARKED.flatMap((file) =>
      unmarkedCheckboxes(read(file)).map((tag) => `${file}: ${tag.slice(0, 60)}`)
    );

    // Positive control: the walk must actually SEE checkboxes on these files, or an empty result is a
    // probe wired to nothing rather than a clean sweep.
    const total = MARKED.reduce((n, file) => n + checkboxTags(read(file)).length, 0);
    expect(total).toBeGreaterThanOrEqual(6);
    expect(unmarkedCheckboxes('<div><Checkbox /></div>')).toHaveLength(1);
    expect(unmarkedCheckboxes('<div data-touch-target><Checkbox /></div>')).toHaveLength(0);
    // An `<input>` is void: a walk that pushed it would leave the stack permanently poisoned with
    // whatever attributes preceded it and report every later checkbox as marked.
    expect(
      unmarkedCheckboxes('<div data-touch-target><input name="x"></div><p><Checkbox /></p>')
    ).toHaveLength(1);

    expect(
      checkboxes,
      'a checkbox on a destructive surface has no `data-touch-target` ancestor, so the ' +
        'coarse-pointer floor leaves its hit area at the primitive default (40x32 — under the ' +
        'floor on both axes).'
    ).toEqual([]);
  });
});
