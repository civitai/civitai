import { describe, expect, it } from 'vitest';
import {
  FEEDBACK_PROMOTE_DRAFT_FIELDS,
  feedbackPanelHasUnsavedDraft,
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

describe('feedbackPanelHasUnsavedDraft', () => {
  /** What the operator had typed when they hit Create issue, still sitting in the draft after. */
  const submitted = {
    ...makeFeedbackPromoteDraft(),
    title: 'sort resets on back',
    summary: 'the store drops the ordering',
  };

  /**
   * 🔴 THE DEFECT THAT WEDGED THE QUEUE. A successful promote sets `bugId` and reloads; on any
   * filter that RETAINS the row — anything but the default `['new']` view, since the row moves to
   * `actioned` — the keyed `{#each}` entry and its `{#if open}` both survive, so `FeedbackDetail` is
   * NOT rebuilt. `FeedbackPromote` swaps to its linked-issue branch and every box unmounts, but the
   * draft object lives in the parent and survives. Reported dirty from there, it made every row
   * click in the queue do nothing for the life of the page, with no box on screen holding the text
   * being protected and no message explaining it.
   *
   * The draft is deliberately UNCHANGED between the two assertions — only `bugId` moves — so this
   * pins the row half and cannot pass by the draft happening to be clean.
   */
  it('stops reporting a submitted draft once the row is linked', () => {
    expect(feedbackPanelHasUnsavedDraft({ bugId: null }, submitted)).toBe(true);
    expect(feedbackPanelHasUnsavedDraft({ bugId: 4102 }, submitted)).toBe(false);
  });

  /**
   * ⚠️ IT READS THE ROW, NOT A SUBMIT, and that covers one case a success callback cannot: a
   * colleague linking this report while the panel is open arrives through the same reload, with no
   * local submit to hang anything on.
   */
  it('is false for a linked row whatever the draft holds', () => {
    expect(feedbackPanelHasUnsavedDraft({ bugId: 4102 }, makeFeedbackPromoteDraft())).toBe(false);
    expect(
      feedbackPanelHasUnsavedDraft({ bugId: 1 }, { ...makeFeedbackPromoteDraft(), bugId: '99' })
    ).toBe(false);
  });

  /** An unlinked row still delegates to the dirty check, both ways — the guard is a gate, not a mute. */
  it('follows the draft on an unlinked row', () => {
    expect(feedbackPanelHasUnsavedDraft({ bugId: null }, makeFeedbackPromoteDraft())).toBe(false);
    expect(feedbackPanelHasUnsavedDraft({ bugId: null }, submitted)).toBe(true);
  });
});
