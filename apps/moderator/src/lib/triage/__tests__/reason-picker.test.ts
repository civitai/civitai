import { describe, expect, it } from 'vitest';
import {
  awaitNote,
  awaitingDecision,
  closeIfOutOfRange,
  openPicker,
  reasonChosen,
  resetPicker,
  type ReasonPickerState,
} from '../reason-picker';

const state = (over: Partial<ReasonPickerState> = {}): ReasonPickerState => ({
  open: null,
  awaitingNote: null,
  ...over,
});

describe('the wait for a note', () => {
  it('is dropped when another list opens, so Enter cannot submit the earlier decision', () => {
    const s = state({ awaitingNote: 0 });
    openPicker(s, 1);
    expect(s).toEqual({ open: 1, awaitingNote: null });
  });

  it('is dropped when the bar goes, so the next row starts clean', () => {
    const s = state({ open: 1, awaitingNote: 0 });
    resetPicker(s);
    expect(s).toEqual({ open: null, awaitingNote: null });
  });

  it('is dropped when the reason changes to one that needs no note', () => {
    const s = state({ awaitingNote: 0 });
    reasonChosen(s, true);
    expect(s.awaitingNote).toBe(0);
    reasonChosen(s, false);
    expect(s.awaitingNote).toBeNull();
  });

  it('only names a decision this row still has', () => {
    const s = state();
    awaitNote(s, 3);
    expect(awaitingDecision(s, 4)).toBe(3);
    expect(awaitingDecision(s, 2)).toBeNull();
    expect(awaitingDecision(state(), 2)).toBeNull();
  });
});

describe('closeIfOutOfRange', () => {
  it('closes a list whose decision disappeared, which would otherwise block J/K for good', () => {
    const s = state({ open: 3 });
    closeIfOutOfRange(s, 2);
    expect(s.open).toBeNull();
  });
  it('leaves a list on a decision that is still there', () => {
    const s = state({ open: 1 });
    closeIfOutOfRange(s, 2);
    expect(s.open).toBe(1);
  });
});
