import { describe, expect, it } from 'vitest';
import { hasCrucibleStarted } from '../crucible';

const now = new Date('2026-10-05T12:00:00Z');

describe('hasCrucibleStarted', () => {
  it('is true once the status has left Pending', () => {
    expect(hasCrucibleStarted({ status: 'Active', startAt: null }, now)).toBe(true);
    expect(hasCrucibleStarted({ status: 'Cancelled', startAt: null }, now)).toBe(true);
  });

  it('counts a Pending crucible whose start time has passed', () => {
    expect(hasCrucibleStarted({ status: 'Pending', startAt: '2026-10-05T11:00:00Z' }, now)).toBe(
      true
    );
  });

  it('is false for a Pending crucible scheduled later or unscheduled', () => {
    expect(hasCrucibleStarted({ status: 'Pending', startAt: new Date('2026-10-06') }, now)).toBe(
      false
    );
    expect(hasCrucibleStarted({ status: 'Pending', startAt: null }, now)).toBe(false);
  });
});
