import { describe, expect, it } from 'vitest';
import { formActionHref, nextUndecided, step, triageKeyAction } from '../appeal-triage';

const key = (k: string, over: Partial<Parameters<typeof triageKeyAction>[0]> = {}) =>
  triageKeyAction({ key: k, ctrlKey: false, metaKey: false, altKey: false, typing: false, ...over });

describe('triageKeyAction', () => {
  it.each([
    ['j', 'next'],
    ['J', 'next'],
    ['ArrowDown', 'next'],
    ['k', 'previous'],
    ['ArrowUp', 'previous'],
    ['u', 'uphold'],
    ['U', 'uphold'],
    ['o', 'overturn'],
    ['x', null],
    ['Enter', null],
  ])('%s -> %s', (k, action) => {
    expect(key(k)).toBe(action);
  });

  it('ignores keys while typing or with a modifier', () => {
    expect(key('u', { typing: true })).toBeNull();
    expect(key('j', { metaKey: true })).toBeNull();
    expect(key('o', { ctrlKey: true })).toBeNull();
    expect(key('k', { altKey: true })).toBeNull();
  });
});

describe('step', () => {
  const ids = [10, 20, 30];
  it('moves and clamps at both ends', () => {
    expect(step(ids, 10, 1)).toBe(20);
    expect(step(ids, 30, 1)).toBe(30);
    expect(step(ids, 10, -1)).toBe(10);
  });
  it('starts at the first item when nothing is selected or the selection is gone', () => {
    expect(step(ids, null, 1)).toBe(10);
    expect(step(ids, 99, -1)).toBe(10);
  });
  it('returns null for an empty queue', () => {
    expect(step([], null, 1)).toBeNull();
  });
});

describe('nextUndecided', () => {
  const ids = [1, 2, 3, 4];
  it('prefers the next one after the current', () => {
    expect(nextUndecided(ids, 2, (id) => id === 2)).toBe(3);
  });
  it('skips decided items ahead', () => {
    expect(nextUndecided(ids, 1, (id) => id === 1 || id === 2)).toBe(3);
  });
  it('falls back to the nearest earlier item at the end of the list', () => {
    expect(nextUndecided(ids, 4, (id) => id === 4 || id === 3)).toBe(2);
  });
  it('is null when everything is decided', () => {
    expect(nextUndecided(ids, 2, () => true)).toBeNull();
  });
});

describe('formActionHref', () => {
  it('keeps the page query after the action name', () => {
    expect(formActionHref('upholdAppeal', { source: 'hash', q: undefined, page: 2 })).toBe(
      '?/upholdAppeal&source=hash&page=2'
    );
  });
  it('is the bare action with no query', () => {
    expect(formActionHref('overturnAppeal', {})).toBe('?/overturnAppeal');
  });
});
