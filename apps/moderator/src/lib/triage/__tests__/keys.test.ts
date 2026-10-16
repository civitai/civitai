import { describe, expect, it } from 'vitest';
import { isTypingTarget, TYPING_SELECTOR, triageKeyAction } from '../keys';

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
    ['j', 'next'],
    ['J', 'next'],
    ['ArrowDown', null],
    ['k', 'previous'],
    ['K', 'previous'],
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
    expect(key('j', { decisionEnabled })).toBe('next');
  });

  it('ignores handled and composing events', () => {
    expect(key('j', { defaultPrevented: true })).toBeNull();
    expect(key('j', { isComposing: true })).toBeNull();
  });

  it('ignores keys while typing or with a modifier', () => {
    expect(key('1', { typing: true })).toBeNull();
    expect(key('j', { metaKey: true })).toBeNull();
    expect(key('2', { ctrlKey: true })).toBeNull();
    expect(key('k', { altKey: true })).toBeNull();
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
