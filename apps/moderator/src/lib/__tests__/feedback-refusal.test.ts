import { describe, expect, it } from 'vitest';
import { FEEDBACK_FORM_NAMES, feedbackRefusal } from '$lib/feedback-refusal';
import { FEEDBACK_FORM_TAB, FEEDBACK_TABS, type FeedbackTab } from '$lib/feedback-tabs';

const TRIAGE_MSG = 'Someone else set this to resolved while you had it open.';
const PROMOTE_MSG = 'Issue #4102 does not exist.';

/** Distinct from every tab id and from both messages, so nothing can match it by coincidence. */
const none = { triage: null, promote: null };

describe('the form ledger', () => {
  /**
   * 🔴 A RELATIONSHIP, NOT A COUNT. `feedbackRefusal` walks `FEEDBACK_FORM_NAMES`, and anything
   * absent from that tuple is a form whose refusal the banner can never show — a silent failure of
   * exactly the kind the banner exists to prevent. Fails when the mapping GROWS (a third form added
   * to `FEEDBACK_FORM_TAB` and not here) and when it SHRINKS (a name left here after its form is
   * gone, which would read a permanently-undefined error).
   */
  it('covers every form in FEEDBACK_FORM_TAB, and nothing else', () => {
    expect([...FEEDBACK_FORM_NAMES].sort()).toEqual(Object.keys(FEEDBACK_FORM_TAB).sort());
  });
});

describe('feedbackRefusal', () => {
  it('says nothing when neither form was refused', () => {
    for (const tab of FEEDBACK_TABS) expect(feedbackRefusal(none, tab.id)).toBeNull();
  });

  it('shows a lone refusal bare on its own tab', () => {
    expect(feedbackRefusal({ triage: TRIAGE_MSG, promote: null }, 'triage')).toBe(TRIAGE_MSG);
    expect(feedbackRefusal({ triage: null, promote: PROMOTE_MSG }, 'issue')).toBe(PROMOTE_MSG);
  });

  /** Off the owning tab the message has to say where to go, or it is an instruction with no address. */
  it.each([['message'], ['context'], ['issue']] as Array<[FeedbackTab]>)(
    'names the Triage tab when read from %s',
    (tab) => {
      expect(feedbackRefusal({ triage: TRIAGE_MSG, promote: null }, tab)).toBe(
        `${TRIAGE_MSG} (on the Triage tab)`
      );
    }
  );

  it.each([['message'], ['context'], ['triage']] as Array<[FeedbackTab]>)(
    'names the Issue tab when read from %s',
    (tab) => {
      expect(feedbackRefusal({ triage: null, promote: PROMOTE_MSG }, tab)).toBe(
        `${PROMOTE_MSG} (on the Issue tab)`
      );
    }
  );

  /**
   * 🔴 THE REGRESSION. The rule this replaced was "triage wins when both are set", justified by a
   * claim that both could not be. Refuse a triage save, move to the Issue tab, refuse a promote:
   * both are set, and the fixed preference showed the OLDER triage message while the refusal the
   * operator had just caused never appeared. The operator's next move is on the tab they are on, so
   * that is the form whose answer the banner owes them.
   *
   * Both arms are asserted, and they are asserted to differ: a rule that ignored `activeTab`
   * entirely would satisfy one arm and fail the other whichever constant it preferred.
   */
  it('prefers the refusal belonging to the tab the operator is on', () => {
    const both = { triage: TRIAGE_MSG, promote: PROMOTE_MSG };
    expect(feedbackRefusal(both, 'issue')).toBe(PROMOTE_MSG);
    expect(feedbackRefusal(both, 'triage')).toBe(TRIAGE_MSG);
  });

  /**
   * With both live and the operator on a tab that owns neither, there is no "the one you just
   * caused" to prefer — the tuple order decides, and the banner still names where to go.
   */
  it.each([['message'], ['context']] as Array<[FeedbackTab]>)(
    'falls back to the declared order on %s, which owns neither form',
    (tab) => {
      expect(feedbackRefusal({ triage: TRIAGE_MSG, promote: PROMOTE_MSG }, tab)).toBe(
        `${TRIAGE_MSG} (on the Triage tab)`
      );
    }
  );

  /** An empty string is not a refusal — a blank banner is worse than none, and reads as a bug. */
  it('treats an empty message as no refusal', () => {
    expect(feedbackRefusal({ triage: '', promote: null }, 'triage')).toBeNull();
    expect(feedbackRefusal({ triage: '', promote: PROMOTE_MSG }, 'triage')).toBe(
      `${PROMOTE_MSG} (on the Issue tab)`
    );
  });
});
