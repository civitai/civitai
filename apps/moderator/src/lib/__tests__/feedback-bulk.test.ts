import { describe, expect, it } from 'vitest';
import { FEEDBACK_PAGE_SIZE, FEEDBACK_STATUSES } from '$lib/feedback';
import {
  FEEDBACK_BULK_ACTIONS,
  FEEDBACK_BULK_MAX,
  blockImplicitBulkSubmit,
  encodeFeedbackBulkRows,
  feedbackBulkOutcome,
  parseFeedbackBulkRows,
  type FeedbackBulkRow,
} from '$lib/feedback-bulk';

/**
 * The selection bar's wire format.
 *
 * The property under test throughout is that this parser REFUSES what it cannot read in full rather
 * than dropping it. Every pair names a report the operator ticked and watched the bar count, so a
 * dropped pair is a report that keeps its old status while the screen reports a number that
 * included it — the `parseIdList` silent-truncation defect, on a destructive action.
 */

const rows = (...pairs: [number, string][]): FeedbackBulkRow[] =>
  pairs.map(([id, expectedStatus]) => ({ id, expectedStatus }) as FeedbackBulkRow);

describe('parseFeedbackBulkRows', () => {
  it('round-trips what the bar encodes', () => {
    const input = rows([12, 'new'], [15, 'reviewed'], [9, 'dismissed']);
    expect(parseFeedbackBulkRows(encodeFeedbackBulkRows(input))).toEqual(input);
  });

  /**
   * 🔴 THE CENTRAL CLAIM. A parser that dropped the unreadable pair would return the other two and
   * the action would report "Updated 2 reports" over a selection of three — so the assertion is on
   * the REFUSAL, and the control beside it proves the same input minus the bad pair is accepted.
   * Without that control this test passes against a parser that refuses everything.
   */
  it.each([
    ['an unknown status', '12:new,15:banana,9:dismissed'],
    ['a non-numeric id', '12:new,fifteen:reviewed,9:dismissed'],
    ['a missing status', '12:new,15,9:dismissed'],
    ['an empty status', '12:new,15:,9:dismissed'],
    ['an extra colon', '12:new,15:reviewed:extra,9:dismissed'],
    ['a negative id', '12:new,-15:reviewed,9:dismissed'],
    ['an id past int4', '12:new,2147483648:reviewed,9:dismissed'],
  ])('refuses the WHOLE submission on %s', (_label, raw) => {
    expect(typeof parseFeedbackBulkRows(raw)).toBe('string');
  });

  it('accepts the same submission once the unreadable pair is removed', () => {
    // The positive control for the table above: these inputs differ from it by the bad pair alone.
    expect(parseFeedbackBulkRows('12:new,9:dismissed')).toEqual(rows([12, 'new'], [9, 'dismissed']));
  });

  it('refuses a duplicate id rather than deduplicating it', () => {
    // Two pairs naming one row carry two different expectations, and there is no basis to pick one.
    expect(typeof parseFeedbackBulkRows('12:new,12:reviewed')).toBe('string');
  });

  it('refuses an empty selection', () => {
    expect(typeof parseFeedbackBulkRows('')).toBe('string');
    expect(typeof parseFeedbackBulkRows('   ')).toBe('string');
  });

  /**
   * 🔴 THE BOUND REFUSES, IT DOES NOT TRUNCATE, and the pair of assertions is what pins that: at the
   * limit every row survives, one past it nothing does. A `.slice(0, max)` passes the first
   * assertion alone.
   */
  it('refuses past the limit rather than truncating to it', () => {
    const atLimit = Array.from({ length: 5 }, (_, i): [number, string] => [i + 1, 'new']);
    const overLimit = Array.from({ length: 6 }, (_, i): [number, string] => [i + 1, 'new']);

    expect(parseFeedbackBulkRows(encodeFeedbackBulkRows(rows(...atLimit)), 5)).toHaveLength(5);
    expect(typeof parseFeedbackBulkRows(encodeFeedbackBulkRows(rows(...overLimit)), 5)).toBe(
      'string'
    );
  });

  it('defaults its limit to FEEDBACK_BULK_MAX', () => {
    const over = Array.from({ length: FEEDBACK_BULK_MAX + 1 }, (_, i): [number, string] => [
      i + 1,
      'new',
    ]);
    expect(typeof parseFeedbackBulkRows(encodeFeedbackBulkRows(rows(...over)))).toBe('string');
  });
});

/**
 * 🔴 A LEDGER OVER A RELATIONSHIP, NOT A COUNT. It fails when the status set GROWS (a verdict the
 * queue can hold and the bar cannot set — invisible until someone looks for the missing button) and
 * when it SHRINKS (a button posting a status the server's enum will refuse).
 */
describe('FEEDBACK_BULK_ACTIONS', () => {
  it('offers exactly one action per feedback status', () => {
    expect(FEEDBACK_BULK_ACTIONS.map((a) => a.status)).toEqual([...FEEDBACK_STATUSES]);
  });

  it('gives every action a label that is not just the status word', () => {
    for (const action of FEEDBACK_BULK_ACTIONS) {
      expect(action.label.length).toBeGreaterThan(0);
      expect(action.label).not.toBe(action.status);
    }
  });
});

/**
 * 🔴 THE BOUND MUST STILL COVER A FULL PAGE, AND "IT IS DERIVED" IS NOT A GUARD.
 *
 * `FEEDBACK_BULK_MAX` is written as `= FEEDBACK_PAGE_SIZE`, and a derivation genuinely cannot drift
 * — while it remains one. A later edit replacing it with a literal is the whole risk, and measured:
 * a mutant substituting `10` SURVIVED the entire suite once the earlier pin test was removed as
 * redundant. It is restored because it now costs nothing — `FEEDBACK_PAGE_SIZE` moved to
 * `$lib/feedback.ts`, so this no longer has to mock a database module to read one integer.
 *
 * Consequence if it ever goes under: selection is cleared on every list change, so a full page is
 * exactly what an operator can select — and the bar would refuse work they are plainly looking at.
 */
describe('the bulk limit against the queue page size', () => {
  it('can carry a full page of selected rows', () => {
    expect(FEEDBACK_BULK_MAX).toBeGreaterThanOrEqual(FEEDBACK_PAGE_SIZE);
  });
});

describe('feedbackBulkOutcome', () => {
  const outcome = (over: Partial<Parameters<typeof feedbackBulkOutcome>[0]> = {}) =>
    feedbackBulkOutcome({
      status: 'reviewed',
      changed: 4,
      actionable: 4,
      skipped: 0,
      ...over,
    });

  it('names the verdict that was applied', () => {
    // The bar unmounts on success, taking its buttons with it — this sentence is then the only
    // thing on screen saying what happened.
    expect(outcome()).toBe('Set 4 reports to reviewed.');
  });

  /**
   * 🔴 THE WHOLE STRING, NOT SUBSTRINGS — because the artifact under test IS prose, and a guard on
   * words is walkable by rewording. Measured: a mutant that prefixed the refused clause with a
   * junk token SURVIVED a battery of `toContain` assertions, because every substring it named was
   * still present. The composite case is pinned exactly; the focused assertions below then say
   * WHICH claim each clause is making, which an exact match alone does not express.
   *
   * A cosmetic reword fails this test. That is the price of a machine-readable claim, and it is
   * worth paying for the one sentence that tells an operator what just happened to fifty rows.
   */
  it('renders the three-part outcome exactly', () => {
    expect(outcome({ changed: 6, actionable: 9, skipped: 4 })).toBe(
      'Set 6 reports to reviewed. ' +
        '3 reports did not change — triaged elsewhere, or no longer in the queue. ' +
        '4 reports were already reviewed.'
    );
  });

  it('reports refused rows without asserting a cause', () => {
    const message = outcome({ changed: 3, actionable: 5 });
    expect(message).toContain('2 reports did not change');
    // 🔴 THE CAUSE IS UNKNOWN. The service does not read per refusal, so a row a colleague triaged
    // and a row that was DELETED land here identically — naming the first sends the operator
    // looking for a verdict on a report that no longer exists.
    expect(message).not.toMatch(/someone else/i);
    expect(message).toMatch(/no longer in the queue/i);
  });

  it('accounts for rows that were already at the target', () => {
    // Without this clause "I selected 10" silently becomes "Set 6" with nothing explaining the rest.
    expect(outcome({ changed: 6, actionable: 6, skipped: 4 })).toContain(
      '4 reports were already reviewed'
    );
  });

  it('does not tell the operator to reload — the bar already did', () => {
    // `FormState({ reload: true })` re-runs `load` before this renders; saying otherwise trains
    // them to distrust a screen that is current.
    expect(outcome({ changed: 3, actionable: 5, skipped: 2 })).not.toMatch(/reload/i);
  });

  it('singularises every count independently', () => {
    const message = outcome({ changed: 1, actionable: 2, skipped: 1 });
    expect(message).toContain('Set 1 report to reviewed.');
    // 🔴 The refused clause had its own pluraliser bug: `1 were already…`. Each count carries its
    // own verb.
    expect(message).toContain('1 report did not change');
    expect(message).toContain('1 report was already reviewed');
  });
});

/**
 * 🔴 THE ONLY THING STANDING BETWEEN A TYPED NOTE AND AN ACCIDENTAL MASS REOPEN. A bulk action has
 * no default verdict, but HTML implicit submission picks the FIRST submit button anyway — Reopen —
 * which would also overwrite every selected row's `triageNote` with the text just typed.
 */
describe('blockImplicitBulkSubmit', () => {
  const press = (key: string) => {
    let prevented = false;
    blockImplicitBulkSubmit({ key, preventDefault: () => (prevented = true) });
    return prevented;
  };

  it('swallows Enter', () => {
    expect(press('Enter')).toBe(true);
  });

  it('leaves every other key alone', () => {
    // The positive control for the assertion above: a guard that prevented everything would pass it
    // while making the box untypeable.
    for (const key of ['a', ' ', 'Tab', 'Escape', 'Backspace']) expect(press(key)).toBe(false);
  });
});
