import { clickDecision, setReasonOpener } from './decision-form';
import {
  awaitNote,
  awaitingDecision,
  closeIfOutOfRange,
  closePicker,
  openPicker,
  reasonChosen,
  resetPicker,
  type ReasonPickerState,
} from './reason-picker';

/**
 * The numbered reason list of the open item's decision bar. Shared so the shell can stop J/K and the
 * decision digits while it is open, and so a decision key can open it from outside the bar. At most
 * one item's bar is mounted; each form resets the list when it goes.
 */
export const reasonPicker = $state<ReasonPickerState>({ open: null, awaitingNote: null });

export const openReasonPicker = (index: number) => openPicker(reasonPicker, index);
export const closeReasonPicker = () => closePicker(reasonPicker);
/** Close the list and drop any wait for a note. */
export const resetReasonPicker = () => resetPicker(reasonPicker);
export const awaitReasonNote = (index: number) => awaitNote(reasonPicker, index);
export const noteReasonChosen = (needsNote: boolean) => reasonChosen(reasonPicker, needsNote);
export const closeReasonPickerBeyond = (decisionCount: number) =>
  closeIfOutOfRange(reasonPicker, decisionCount);

/** Enter in the note field: submits the decision a note-requiring reason was picked for, if this row
 *  still has it. */
export const submitAwaitingNote = (decisionCount: number) => {
  const index = awaitingDecision(reasonPicker, decisionCount);
  if (index !== null) clickDecision(index);
};

// Every decision key opens the list through here, so a queue cannot forget to.
setReasonOpener(openReasonPicker);
