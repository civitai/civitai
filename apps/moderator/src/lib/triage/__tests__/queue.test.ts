import { describe, expect, it } from 'vitest';
import { failureBanner, failureMessage, formActionHref, nextUndecided, step } from '../queue';

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

describe('string keys (re-detected rows)', () => {
  const ids = ['1:minor', '1:poi', '2:minor'];
  it('steps and skips decided rows the same way', () => {
    expect(step(ids, '1:minor', 1)).toBe('1:poi');
    expect(step(ids, '2:minor', 1)).toBe('2:minor');
    expect(nextUndecided(ids, '1:poi', (id) => id === '1:poi')).toBe('2:minor');
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

describe('failureMessage', () => {
  it('is null for a success', () => {
    expect(failureMessage({ type: 'success' })).toBeNull();
  });
  it('uses the action error, else a generic one', () => {
    expect(failureMessage({ type: 'failure', data: { error: 'Nope.' } })).toBe('Nope.');
    expect(failureMessage({ type: 'failure', data: {} })).toBe('Action failed.');
    expect(failureMessage({ type: 'error' })).toBe('Action failed.');
  });
});

describe('failureBanner', () => {
  it('prefixes the subject when the action named one', () => {
    expect(failureBanner({ error: 'Nope.', subject: 'Model #5' })).toBe('Model #5: Nope.');
  });
  it('shows the bare error without a subject', () => {
    expect(failureBanner({ error: 'Nope.' })).toBe('Nope.');
  });
  it('is null when there is no error', () => {
    expect(failureBanner({ subject: 'Model #5' })).toBeNull();
    expect(failureBanner(null)).toBeNull();
  });
});
