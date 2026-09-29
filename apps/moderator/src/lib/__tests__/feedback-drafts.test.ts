import { describe, expect, it } from 'vitest';
import { FEEDBACK_PROMOTE_DRAFT_FIELDS, makeFeedbackPromoteDraft } from '$lib/feedback-drafts';

describe('makeFeedbackPromoteDraft', () => {
  it('starts blank, because this form creates an issue rather than editing one', () => {
    expect(makeFeedbackPromoteDraft()).toEqual({
      attachMode: false,
      bugId: '',
      title: '',
      summary: '',
      // Blank, not null: this is a form draft, and the box is a `bind:value`-d text input. The
      // '' -> null conversion is the ACTION's job, so the column carries one spelling of "absent".
      clickupUrl: '',
    });
  });

  /**
   * The ledger and the shape must not drift apart: `FEEDBACK_PROMOTE_DRAFT_FIELDS` is asserted
   * against the promote form's `name=` attributes by the panel tripwires, so a field that exists in
   * the draft but not in the ledger is a box that can never be pinned, and one in the ledger but not
   * in the draft is a `bind:value` to nothing.
   */
  it('holds exactly the ledger fields, plus the mode toggle that posts under another name', () => {
    const keys = Object.keys(makeFeedbackPromoteDraft()).sort();
    expect(keys).toEqual([...FEEDBACK_PROMOTE_DRAFT_FIELDS, 'attachMode'].sort());
  });
});
