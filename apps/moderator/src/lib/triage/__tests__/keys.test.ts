import { describe, expect, it } from 'vitest';
import {
  bulkReviewKeyAction,
  isRevealKey,
  isTypingTarget,
  reasonPickerKeyAction,
  TYPING_SELECTOR,
  triageKeyAction,
} from '../keys';

const key = (k: string, over: Partial<Parameters<typeof triageKeyAction>[0]> = {}) =>
  triageKeyAction({
    key: k,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    typing: false,
    decisionEnabled: [true, true],
    defaultPrevented: false,
    isComposing: false,
    ...over,
  });

describe('triageKeyAction', () => {
  it.each([
    ['j', 'previous'],
    ['J', 'previous'],
    ['ArrowDown', null],
    ['k', 'next'],
    ['K', 'next'],
    ['ArrowUp', null],
    ['1', { decision: 0 }],
    ['2', { decision: 1 }],
    ['3', null],
    ['0', null],
    ['u', null],
    ['o', null],
    ['x', null],
    ['Enter', null],
  ])('%s -> %s', (k, action) => {
    expect(key(k)).toEqual(action);
  });

  it('makes a disabled decision a no-op, leaving the other keys alone', () => {
    const decisionEnabled = [false, true];
    expect(key('1', { decisionEnabled })).toBeNull();
    expect(key('2', { decisionEnabled })).toEqual({ decision: 1 });
    expect(key('j', { decisionEnabled })).toBe('previous');
  });

  it('ignores handled and composing events', () => {
    expect(key('j', { defaultPrevented: true })).toBeNull();
    expect(key('j', { isComposing: true })).toBeNull();
  });

  it('ignores every key while a dialog is open', () => {
    for (const k of ['1', '2', 'j', 'k']) expect(key(k, { dialogOpen: true })).toBeNull();
  });

  it('ignores keys while typing or with a modifier', () => {
    expect(key('1', { typing: true })).toBeNull();
    expect(key('j', { metaKey: true })).toBeNull();
    expect(key('2', { ctrlKey: true })).toBeNull();
    expect(key('k', { altKey: true })).toBeNull();
  });
});

describe('triageKeyAction with more than two decisions', () => {
  it('gives every decision a digit, in order', () => {
    const decisionEnabled = [true, true, true, true];
    expect(key('3', { decisionEnabled })).toEqual({ decision: 2 });
    expect(key('4', { decisionEnabled })).toEqual({ decision: 3 });
    expect(key('5', { decisionEnabled })).toBeNull();
  });
});

describe('triageKeyAction while the reason list is open', () => {
  it('leaves every key to the list, row navigation included', () => {
    for (const k of ['j', 'k', '1', '2']) expect(key(k, { picking: true })).toBeNull();
  });
});

describe('reasonPickerKeyAction', () => {
  const pick = (k: string, over: Partial<Parameters<typeof reasonPickerKeyAction>[0]> = {}) =>
    reasonPickerKeyAction({
      key: k,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      repeat: false,
      typing: false,
      onControl: false,
      reasonCount: 3,
      hasSelection: true,
      ...over,
    });

  it('picks the reason a digit names, and ignores digits past the list', () => {
    expect(pick('1')).toEqual({ pick: 0 });
    expect(pick('3')).toEqual({ pick: 2 });
    expect(pick('4')).toBeNull();
    expect(pick('0')).toBeNull();
  });

  it('submits on Enter only when a reason is selected', () => {
    expect(pick('Enter')).toBe('submit');
    expect(pick('Enter', { hasSelection: false })).toBeNull();
  });

  it('leaves Enter to a focused button so it is not pressed twice', () => {
    expect(pick('Enter', { onControl: true })).toBeNull();
  });

  it('closes on Escape, even from the note field', () => {
    expect(pick('Escape')).toBe('close');
    expect(pick('Escape', { typing: true })).toBe('close');
  });

  it('does not take digits or Enter while typing, with a modifier, or on a key repeat', () => {
    expect(pick('1', { typing: true })).toBeNull();
    expect(pick('Enter', { typing: true })).toBeNull();
    expect(pick('1', { metaKey: true })).toBeNull();
    expect(pick('1', { repeat: true })).toBeNull();
    expect(pick('Escape', { repeat: true })).toBeNull();
  });
});

describe('isTypingTarget', () => {
  it('asks for fields and for every overlay role', () => {
    for (const part of [
      'input',
      'textarea',
      'select',
      'contenteditable',
      'dialog',
      'menu',
      'listbox',
      'combobox',
    ])
      expect(TYPING_SELECTOR).toContain(part);
  });
  it('is true only when the element matches', () => {
    expect(isTypingTarget({ closest: () => ({}) })).toBe(true);
    expect(isTypingTarget({ closest: () => null })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget({})).toBe(false);
  });
});

describe('isRevealKey', () => {
  const press = (over: Partial<Parameters<typeof isRevealKey>[0]> = {}) =>
    isRevealKey({
      key: 'v',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      repeat: false,
      defaultPrevented: false,
      isComposing: false,
      typing: false,
      dialogOpen: false,
      ...over,
    });

  it('takes V in either case', () => {
    expect(press()).toBe(true);
    expect(press({ key: 'V' })).toBe(true);
    expect(press({ key: 'x' })).toBe(false);
  });

  it.each([
    ['a modifier', { metaKey: true }],
    ['a held key', { repeat: true }],
    ['typing', { typing: true }],
    ['an open dialog', { dialogOpen: true }],
    ['a handled event', { defaultPrevented: true }],
    ['composition', { isComposing: true }],
  ])('ignores V with %s', (_label, over) => {
    expect(press(over)).toBe(false);
  });
});

describe('bulkReviewKeyAction', () => {
  const bulk = (k: string, over: Partial<Parameters<typeof bulkReviewKeyAction>[0]> = {}) =>
    bulkReviewKeyAction({
      key: k,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      typing: false,
      defaultPrevented: false,
      isComposing: false,
      onControl: false,
      ...over,
    });

  it.each([
    ['k', 'next'],
    ['ArrowDown', 'next'],
    ['j', 'previous'],
    ['ArrowUp', 'previous'],
    ['Enter', 'toggle'],
    [' ', 'toggle'],
    ['x', null],
  ])('%s → %s', (k, action) => expect(bulk(k)).toBe(action));

  it('leaves Enter to a focused button, and every key to a field or a dialog', () => {
    expect(bulk('Enter', { onControl: true })).toBeNull();
    expect(bulk('k', { typing: true })).toBeNull();
    expect(bulk('Enter', { dialogOpen: true })).toBeNull();
    expect(bulk('ArrowDown', { ctrlKey: true })).toBeNull();
  });
});
