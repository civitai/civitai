import { describe, expect, it } from 'vitest';
import {
  FEEDBACK_PROMOTE_DRAFT_FIELDS,
  makeFeedbackPromoteDraft,
  reseedTriageNote,
} from '$lib/feedback-drafts';

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

describe('reseedTriageNote', () => {
  /**
   * 🔴 THE CASE THE FUNCTION EXISTS FOR. Only the status buttons are disabled while the triage form
   * submits — the textarea is not — so text can arrive between the click and the response. An
   * unconditional re-seed from the reloaded column discarded it.
   *
   * The fixtures are pairwise distinct AND distinct from each other's substrings, so a mutant that
   * returns any one of the three arguments unconditionally is visible in at least one case here.
   */
  it('keeps text typed while the request was in flight', () => {
    expect(reseedTriageNote('posted text plus more', 'posted text', 'stored text')).toBe(
      'posted text plus more'
    );
  });

  it('takes the reloaded column when the box still holds exactly what was posted', () => {
    expect(reseedTriageNote('posted text', 'posted text', 'stored text')).toBe('stored text');
  });

  /**
   * The server is free to normalise; when the operator has typed nothing since, its answer is the
   * one to show. This is the case that separates "re-seed" from "do nothing".
   */
  it('adopts a server-side normalisation the operator did not type', () => {
    expect(reseedTriageNote('  padded  ', '  padded  ', 'padded')).toBe('padded');
  });

  /**
   * `null` means no submit captured anything — `onSubmit` never ran, or the state was cleared. The
   * stored column wins, which is the unconditional behaviour this replaced rather than a third rule
   * invented for the gap.
   */
  it('falls back to the stored column when nothing was captured', () => {
    expect(reseedTriageNote('whatever is in the box', null, 'stored text')).toBe('stored text');
  });

  /** An empty posted note is a real value, not an absent one: `''` must not read as `null`. */
  it('treats an empty posted note as a value, not as nothing captured', () => {
    expect(reseedTriageNote('typed after clearing', '', 'stored text')).toBe(
      'typed after clearing'
    );
    expect(reseedTriageNote('', '', 'stored text')).toBe('stored text');
  });
});
