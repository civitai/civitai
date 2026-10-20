/**
 * The numbered reason list of the open item's decision bar. Shared so the shell can stop J/K and the
 * decision digits while it is open, and so a decision key can open it from outside the bar. At most
 * one item's bar is mounted, and the list closes itself when that bar goes.
 */
export const reasonPicker = $state<{
  /** The decision whose reasons are listed, as its index in key order. */
  open: number | null;
  /** The decision a note-requiring reason was picked for: Enter in the note field submits it. */
  awaitingNote: number | null;
}>({ open: null, awaitingNote: null });

export const openReasonPicker = (index: number) => {
  reasonPicker.open = index;
};

export const closeReasonPicker = () => {
  reasonPicker.open = null;
};
