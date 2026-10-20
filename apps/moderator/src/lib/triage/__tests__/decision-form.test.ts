import { describe, expect, it } from 'vitest';
import { decisionFormSelector } from '../decision-form';

const formFor = (action: string) => `[data-triage-actions] form[data-triage-action="${action}"]`;

describe('decisionFormSelector', () => {
  it('maps key 1 to the keep form and key 2 to the lift form on a hash row', () => {
    const actions = ['keepFlag', 'liftFlag'];
    expect(decisionFormSelector(actions, [true, true], 0)).toBe(formFor('keepFlag'));
    expect(decisionFormSelector(actions, [true, true], 1)).toBe(formFor('liftFlag'));
  });

  it('maps key 1 to flag as minor and key 2 to dismiss on a match row', () => {
    const actions = ['setMinor', 'dismiss'];
    expect(decisionFormSelector(actions, [true, true], 0)).toBe(formFor('setMinor'));
    expect(decisionFormSelector(actions, [true, true], 1)).toBe(formFor('dismiss'));
  });

  it('yields no form for a disabled decision, and still serves the other one', () => {
    const actions = ['keepFlag', 'liftFlag'];
    expect(decisionFormSelector(actions, [false, true], 0)).toBeNull();
    expect(decisionFormSelector(actions, [false, true], 1)).toBe(formFor('liftFlag'));
  });

  it('yields no form for a key past the decisions', () => {
    expect(decisionFormSelector(['setMinor', 'dismiss'], [true, true], 2)).toBeNull();
  });
});
