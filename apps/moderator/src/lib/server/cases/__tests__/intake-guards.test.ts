import { describe, expect, it } from 'vitest';
import { createIntakeRateLimit, IntakeRateLimitedError } from '../intake-rate-limit';
import { renderNotice } from '../notice-render';

describe('createIntakeRateLimit', () => {
  it('refuses past the limit and opens again after the window', () => {
    let t = 0;
    const hit = createIntakeRateLimit({ limit: 2, windowMs: 1000, now: () => t });
    hit('a');
    hit('a');
    expect(() => hit('a')).toThrow(IntakeRateLimitedError);
    hit('b');
    t = 1000;
    expect(() => hit('a')).not.toThrow();
  });
});

describe('renderNotice', () => {
  it('fills known slots and leaves a slot with no value as written', () => {
    expect(renderNotice('{caseRef} / {items}', { caseRef: 'TD-1' })).toBe('TD-1 / {items}');
  });
});
