import { describe, expect, it } from 'vitest';
import {
  FEEDBACK_PROMOTE_DRAFT_FIELDS,
  isFeedbackPromoteDraftDirty,
  makeFeedbackPromoteDraft,
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

describe('isFeedbackPromoteDraftDirty', () => {
  /**
   * 🔴 THE PREDICATE A STRAY CLICK IS WEIGHED AGAINST. The queue expands a row on a click anywhere
   * in it, which unmounts whatever panel is open — and this draft is the only copy of what the
   * operator has typed. False here and the text is gone with no undo; true and the row goes inert.
   */
  it('is clean for a fresh draft, in either mode', () => {
    expect(isFeedbackPromoteDraftDirty(makeFeedbackPromoteDraft())).toBe(false);
    expect(isFeedbackPromoteDraftDirty({ ...makeFeedbackPromoteDraft(), attachMode: true })).toBe(
      false
    );
  });

  /**
   * 🔴 EVERY LEDGER FIELD ON ITS OWN, ENUMERATED FROM THE LEDGER RATHER THAN LISTED. That constant
   * is already asserted against the promote form's own `name=` attributes, so this case is what
   * makes a NEW box protected the moment it is added: a field in the ledger that this predicate
   * ignores fails here instead of silently losing its own text.
   *
   * The values are pairwise distinct and none of them is a substring of another, so a predicate
   * that hardcoded any single field — or any one literal — is visible in at least one iteration.
   */
  it.each(FEEDBACK_PROMOTE_DRAFT_FIELDS.map((field) => [field] as const))(
    'is dirty when only %s has been typed into',
    (field) => {
      const typed = {
        bugId: '4102',
        title: 'sort resets on back',
        summary: 'the store drops the ordering',
        clickupUrl: 'https://app.clickup.com/t/868kfwm3j',
      }[field];

      expect(isFeedbackPromoteDraftDirty({ ...makeFeedbackPromoteDraft(), [field]: typed })).toBe(
        true
      );
    }
  );

  /** A stray space is not work worth blocking a click over, and the action trims before storing. */
  it('treats whitespace as empty', () => {
    expect(isFeedbackPromoteDraftDirty({ ...makeFeedbackPromoteDraft(), title: '   \n\t ' })).toBe(
      false
    );
  });

  /**
   * 🔴 THE MODE IS NOT CONSULTED, AND THIS IS THE CASE THAT SAYS WHY. A mode-aware predicate — check
   * title/summary/clickupUrl in create mode, bugId in attach mode — describes what is VISIBLE, and
   * the question is what would be LOST. Flipping the toggle clears nothing, so a title typed in
   * create mode is still in the draft after switching to attach, and a mode-aware rule reports clean
   * while that title goes with the panel.
   *
   * Both directions, so the answer is pinned as mode-INDEPENDENT rather than as either branch.
   */
  it('is dirty regardless of which mode the toggle is showing', () => {
    const titled = { ...makeFeedbackPromoteDraft(), title: 'sort resets on back' };
    expect(isFeedbackPromoteDraftDirty({ ...titled, attachMode: false })).toBe(true);
    expect(isFeedbackPromoteDraftDirty({ ...titled, attachMode: true })).toBe(true);

    const numbered = { ...makeFeedbackPromoteDraft(), bugId: '4102' };
    expect(isFeedbackPromoteDraftDirty({ ...numbered, attachMode: true })).toBe(true);
    expect(isFeedbackPromoteDraftDirty({ ...numbered, attachMode: false })).toBe(true);
  });

  /**
   * ⚠️ `attachMode` ALONE IS NOT DIRT. It is a toggle, not typed text — nothing is lost by
   * rebuilding a panel whose only change is which branch was on screen. Pinned so that flipping the
   * toggle does not start making every row in the queue inert.
   */
  it('does not count the mode toggle as typed content', () => {
    expect(isFeedbackPromoteDraftDirty({ ...makeFeedbackPromoteDraft(), attachMode: true })).toBe(
      false
    );
  });
});
