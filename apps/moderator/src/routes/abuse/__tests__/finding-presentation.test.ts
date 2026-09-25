import { describe, expect, it } from 'vitest';
import { ABUSE_VERDICTS } from '$lib/abuse-verdicts';
import {
  VERDICT_CLASS,
  VERDICT_HINT,
  VERDICT_LABEL,
  confidenceLabel,
  moreMembersLabel,
  verdictAttribution,
} from '../[runId]/finding-presentation';
import { LIST_PAGE_DIR, RUN_PAGE_DIR, pageSurface } from './page-sources';

/**
 * The board's sentences.
 *
 * 🔴 EVERY CASE HERE IS A SEPARATOR OR AN AGREEMENT, because those are what a template gets wrong
 * silently. Svelte trims the whitespace at the edges of a block, so a space typed at the start of an
 * `{#if}` is deleted at compile time: the source reads `and 6 more` and the page renders
 * `…1234and 6 more`. Nothing errors, typecheck is clean, and no review that reads the diff sees it,
 * because the diff contains the space.
 *
 * Two of those shipped — the cluster's "and N more" tail and the separator between a ruler and their
 * timestamp — so the last block below pins the CLASS rather than the two instances: any block tag on
 * this board whose content opens with mid-sentence text.
 */

describe('verdictAttribution', () => {
  const at = new Date('2026-09-03T03:20:00Z');
  const stamp = () => 'Sep 3, 2026';

  it('renders nothing when nobody has ruled', () => {
    expect(verdictAttribution(null, at, 77, stamp)).toBeNull();
  });

  it('names the reader as "you"', () => {
    expect(verdictAttribution('77', null, 77, stamp)).toBe('you');
  });

  it('keeps the stored id for anybody else', () => {
    // The column holds an id rather than a username precisely because a rename cannot move an id.
    // Resolving it to a name here would put a handle that has since changed hands beside a ruling.
    expect(verdictAttribution('42', null, 77, stamp)).toBe('moderator #42');
  });

  it('keeps the stored id when there is no reader to compare against', () => {
    expect(verdictAttribution('42', null, null, stamp)).toBe('moderator #42');
  });

  it('🔴 compares as a STRING — a padded id is not the reader', () => {
    // `Number('007') === 7` is true, so a numeric comparison would greet somebody else as themselves.
    expect(verdictAttribution('007', null, 7, stamp)).toBe('moderator #007');
  });

  it('🔴 does not weld the ruler to the timestamp', () => {
    // The shipped defect, verbatim: the separator was typed at the start of an `{#if}` block, so
    // Svelte trimmed the space before it and the board rendered `moderator #42· Sep 3, 2026`.
    expect(verdictAttribution('42', at, 77, stamp)).toBe('moderator #42 · Sep 3, 2026');
  });

  it('renders no separator when there is nothing to separate', () => {
    expect(verdictAttribution('42', null, 77, stamp)).toBe('moderator #42');
  });

  it('formats the timestamp with the formatter it is given, not its own', () => {
    // `dateTime` prints the viewer's zone AND UTC, and that belongs to one module. A second
    // spelling here is how two screens start disagreeing about when something happened.
    expect(verdictAttribution('42', at, null, (d) => `@${d.toISOString()}`)).toBe(
      'moderator #42 · @2026-09-03T03:20:00.000Z'
    );
  });
});

describe('moreMembersLabel', () => {
  it('🔴 opens with a space — the shipped defect was its absence', () => {
    expect(moreMembersLabel(10, 4)).toBe(' and 6 more');
  });

  it('says nothing when every member is already named', () => {
    expect(moreMembersLabel(4, 4)).toBe('');
  });

  it('says nothing when there are fewer members than examples', () => {
    expect(moreMembersLabel(2, 4)).toBe('');
  });

  it('counts one remaining member', () => {
    expect(moreMembersLabel(5, 4)).toBe(' and 1 more');
  });
});

describe('confidenceLabel', () => {
  it('renders two digits, never a percentage', () => {
    // A percentage invites a cross-detector ranking that would be meaningless — the producers do not
    // share a calibration.
    expect(confidenceLabel(0.9137)).toBe('0.91');
    expect(confidenceLabel(1)).toBe('1.00');
  });

  it('🔴 labels 0.00 as a judged verdict rather than leaving it to read as "unscored"', () => {
    // It renders beside a reason that describes the evidence in detail, which reads as
    // self-contradictory unless the zero is explained — a moderator then either dismisses a real
    // finding or trusts a rejected one. The user-lookup panel has said this about the same rows
    // since it was built; this board showed the bare number, so the two screens gave one row two
    // readings.
    expect(confidenceLabel(0)).toContain('0.00');
    expect(confidenceLabel(0)).toMatch(/judged not abuse/i);
  });

  it('says it of zero and of nothing else', () => {
    expect(confidenceLabel(0.01)).toBe('0.01');
    // 🔴 ROUNDS TO 0.00 BUT IS NOT ZERO. A real score below the two-digit floor is not a judged
    // verdict, and labelling it as one would be the board asserting something no detector said.
    expect(confidenceLabel(0.0001)).toBe('0.00');
  });
});

describe('every verdict the board offers is spelled out', () => {
  // 🔴 A LEDGER OVER THE SHARED TUPLE, not three hand-written cases. A fourth verdict added to
  // `ABUSE_VERDICTS` renders a fourth button; without this it would render an EMPTY one, with no
  // hint under it, no colour, and nothing failing.
  it.each(ABUSE_VERDICTS)('%s has a label, a visible hint and both button states', (v) => {
    expect(VERDICT_LABEL[v]?.length ?? 0).toBeGreaterThan(0);
    expect(VERDICT_HINT[v]?.length ?? 0).toBeGreaterThan(0);
    expect(VERDICT_CLASS[v]?.idle?.length ?? 0).toBeGreaterThan(0);
    expect(VERDICT_CLASS[v]?.chosen?.length ?? 0).toBeGreaterThan(0);
  });

  it('offers no label, hint or palette for a verdict the tuple does not contain', () => {
    const tuple = [...ABUSE_VERDICTS].sort();
    expect(Object.keys(VERDICT_LABEL).sort()).toEqual(tuple);
    expect(Object.keys(VERDICT_HINT).sort()).toEqual(tuple);
    expect(Object.keys(VERDICT_CLASS).sort()).toEqual(tuple);
  });

  it.each(ABUSE_VERDICTS)('%s reacts to a hover in BOTH states', (v) => {
    // 🔴 A CHOSEN BUTTON IS STILL CLICKABLE — re-ruling overwrites, deliberately. With its two
    // neighbours lighting up on hover and the filled one inert, it reads as disabled, and that
    // misreading arrived WITH the fill: nothing was distinguishable enough to notice before.
    expect(VERDICT_CLASS[v].idle).toMatch(/\bhover:/);
    expect(VERDICT_CLASS[v].chosen).toMatch(/\bhover:/);
  });

  it('the chosen state is filled, not tinted', () => {
    // The defect: `bg-muted/60` on a transparent button, a lightness step of about 0.03 against this
    // page's panel. A fractional-opacity background is that same non-treatment respelled.
    for (const v of ABUSE_VERDICTS) {
      expect(VERDICT_CLASS[v].chosen).toMatch(/\bbg-[a-z0-9-]+\b/);
      expect(VERDICT_CLASS[v].chosen).not.toMatch(/\bbg-[a-z0-9-]+\/\d/);
    }
  });

  it('the hints are rendered, not hidden behind a hover', () => {
    // 🔴 THE COMMENT ABOVE THEM CLAIMED "spelled out beside the buttons" WHILE THEY WERE A `title`.
    // A tooltip is invisible to a moderator who does not hover, invisible to a touch device, and
    // invisible in the screenshot this team reports by. The claim and the code now agree; this is
    // what stops them drifting apart again.
    const src = pageSurface(RUN_PAGE_DIR);
    expect(src).toMatch(/\{VERDICT_HINT\[v\]\}/);
    expect(src).not.toMatch(/title=\{VERDICT_HINT/);
  });
});

/**
 * 🔴 THE CLASS, NOT THE TWO INSTANCES. Svelte deletes the whitespace at the start of a block's
 * content, so a block whose text opens mid-sentence — a separator, a conjunction, a continuation —
 * welds to whatever preceded the block. Both shipped bugs on this board had exactly this shape, and
 * a guard naming "and" and "·" would be walked past by the third one spelling it differently.
 *
 * A block opening with an element, a comment or another expression is fine and is what almost every
 * block here does; that is why the rule can be this blunt.
 */
const BLOCK_OPENING_WITH_TEXT = /\{[#:][^{}]*\}[^\S\n]*\n?[^\S\n]*[^\s<{]/g;

/**
 * Markup only — comments removed.
 *
 * 🔴 A COMMENT THAT NAMES A BLOCK TAG IS NOT A BLOCK TAG, and this rule is blunt enough to be fooled
 * by one: a line explaining what an each-block key is for read as an each-block opening with welded
 * text. Caught by this very guard on its own diff, which is the one time a false positive is cheap.
 *
 * Conservative on purpose. HTML comments and block comments go whole; a `//` comment is stripped
 * only when it OPENS its line, so a `https://` inside a string cannot be mistaken for one.
 */
export const withoutComments = (src: string): string =>
  src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');

describe('no block on the board opens with text Svelte will weld', () => {
  it('ignores a block tag named inside a comment — false-positive control', () => {
    expect(withoutComments('  // the {#each} key\n<p>x</p>')).not.toMatch(/\{#each\}/);
    expect(withoutComments('<!-- {#if x} and more -->\n<p>x</p>')).not.toMatch(/\{#if/);
    // …and does not eat a URL that merely contains a double slash.
    expect(withoutComments('<a href="https://example.test">x</a>')).toContain(
      'https://example.test'
    );
  });

  it('sees the defect that shipped — negative control', () => {
    // Both, verbatim as they were written.
    const shipped = [
      '{#if d.members.length > EXAMPLES + 1}\n                  and {num(1)} more{/if}',
      '{#if ruledAt(d)} · {dateTime(ruledAt(d) as Date)}{/if}',
    ];
    for (const src of shipped)
      expect([...src.matchAll(BLOCK_OPENING_WITH_TEXT)], src).not.toHaveLength(0);
  });

  it('allows a block that opens with an element — positive control', () => {
    const fine = '{#if run.summary}\n  <p class="x">{run.summary}</p>\n{/if}';
    expect([...fine.matchAll(BLOCK_OPENING_WITH_TEXT)]).toHaveLength(0);
  });

  it.each([RUN_PAGE_DIR, LIST_PAGE_DIR])('%s opens no block with welded text', (dir) => {
    const markup = withoutComments(pageSurface(dir));
    // The strip must not have taken the markup with it — an empty surface passes vacuously.
    expect(markup, `${dir} has no markup left after removing comments`).toMatch(/\{[#:]/);
    const offenders = [...markup.matchAll(BLOCK_OPENING_WITH_TEXT)].map((m) => m[0]);
    expect(offenders).toEqual([]);
  });
});
