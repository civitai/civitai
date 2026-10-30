import { describe, expect, it } from 'vitest';
import {
  FEEDBACK_FORM_NAMES,
  feedbackRefusal,
  type FeedbackFormName,
} from '$lib/feedback-refusal';

const TRIAGE_MSG = 'Someone else set this to resolved while you had it open.';
const PROMOTE_MSG = 'Issue #4102 does not exist.';

const none = { triage: null, promote: null };

describe('the form ledger', () => {
  /**
   * 🔴 A RELATIONSHIP, NOT A COUNT. `feedbackRefusal` walks `FEEDBACK_FORM_NAMES`, and a form absent
   * from that tuple is a form whose refusal the banner can never show — a silent failure of exactly
   * the kind the banner exists to prevent. Fails when the set GROWS and when it SHRINKS.
   *
   * ⚠️ IT USED TO BE PINNED AGAINST `FEEDBACK_FORM_TAB`, the mapping that told the banner which TAB
   * to name. There are no tabs, so that mapping is gone and the names are declared here. The
   * relationship that replaces it is the panel's own: `FeedbackDetail` constructs one `FormState`
   * per name below and nothing else.
   */
  it('is exactly the two forms the panel renders', () => {
    expect([...FEEDBACK_FORM_NAMES]).toEqual(['triage', 'promote']);
  });
});

describe('feedbackRefusal', () => {
  it('says nothing when neither form was refused', () => {
    for (const last of [...FEEDBACK_FORM_NAMES, null] as Array<FeedbackFormName | null>)
      expect(feedbackRefusal(none, last)).toBeNull();
  });

  /**
   * A lone refusal is shown bare, wherever the operator's attention is. Both sections are on screen
   * and the banner sits directly above them, so there is no tab to name and nowhere to send anyone.
   */
  it('shows a lone refusal whatever submitted last', () => {
    for (const last of [...FEEDBACK_FORM_NAMES, null] as Array<FeedbackFormName | null>) {
      expect(feedbackRefusal({ triage: TRIAGE_MSG, promote: null }, last)).toBe(TRIAGE_MSG);
      expect(feedbackRefusal({ triage: null, promote: PROMOTE_MSG }, last)).toBe(PROMOTE_MSG);
    }
  });

  /**
   * 🔴 THE REGRESSION. The rule this replaced was "triage wins when both are set": refuse a triage
   * save, then submit the promote form and have that refused too, and the banner showed the OLDER
   * triage message while the refusal the operator had just caused never appeared. The form they
   * submitted last is the one whose answer they are waiting for.
   *
   * Both arms are asserted, and asserted to DIFFER: a rule that ignored `lastSubmitted` entirely
   * would satisfy one arm and fail the other whichever constant it preferred.
   */
  it('prefers the refusal belonging to the form that submitted most recently', () => {
    const both = { triage: TRIAGE_MSG, promote: PROMOTE_MSG };
    expect(feedbackRefusal(both, 'promote')).toBe(PROMOTE_MSG);
    expect(feedbackRefusal(both, 'triage')).toBe(TRIAGE_MSG);
  });

  /**
   * The fallback, reached whenever no live refusal belongs to the form that last submitted — a
   * standing promote refusal still on screen after a triage save that SUCCEEDED, or a panel whose
   * refusal arrived before anything was submitted in this instance.
   */
  it('falls back to the declared order when the last submitter has nothing to say', () => {
    expect(feedbackRefusal({ triage: TRIAGE_MSG, promote: PROMOTE_MSG }, null)).toBe(TRIAGE_MSG);
    expect(feedbackRefusal({ triage: null, promote: PROMOTE_MSG }, 'triage')).toBe(PROMOTE_MSG);
  });

  /** An empty string is not a refusal — a blank banner is worse than none, and reads as a bug. */
  it('treats an empty message as no refusal', () => {
    expect(feedbackRefusal({ triage: '', promote: null }, 'triage')).toBeNull();
    expect(feedbackRefusal({ triage: '', promote: PROMOTE_MSG }, 'triage')).toBe(PROMOTE_MSG);
  });
});
