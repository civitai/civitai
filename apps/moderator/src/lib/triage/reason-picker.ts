/** The state of the numbered reason list, and its transitions as plain functions so they can be
 *  tested without runes; `reason-picker.svelte.ts` holds the reactive instance. */
export type ReasonPickerState = {
  /** The decision whose reasons are listed, as its index in key order. */
  open: number | null;
  /** The decision a note-requiring reason was picked for: Enter in the note field submits it. */
  awaitingNote: number | null;
};

export const openPicker = (s: ReasonPickerState, index: number) => {
  s.open = index;
  // A later pick supersedes the earlier wait; leaving it would let Enter submit the old decision.
  s.awaitingNote = null;
};

export const closePicker = (s: ReasonPickerState) => {
  s.open = null;
};

/** Close the list and forget any wait for a note: a row or tab change, or a decision being sent. */
export const resetPicker = (s: ReasonPickerState) => {
  s.open = null;
  s.awaitingNote = null;
};

export const awaitNote = (s: ReasonPickerState, index: number) => {
  s.awaitingNote = index;
};

/** A reason that needs no note ends the wait. */
export const reasonChosen = (s: ReasonPickerState, needsNote: boolean) => {
  if (!needsNote) s.awaitingNote = null;
};

/** A re-derive can drop decisions (a split stops being offered) under an open list. */
export const closeIfOutOfRange = (s: ReasonPickerState, decisionCount: number) => {
  if (s.open !== null && s.open >= decisionCount) s.open = null;
};

/** The decision Enter in the note field should submit, only while it still exists on this row. */
export const awaitingDecision = (s: ReasonPickerState, decisionCount: number): number | null =>
  s.awaitingNote !== null && s.awaitingNote < decisionCount ? s.awaitingNote : null;
