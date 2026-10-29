import { describe, expect, it } from 'vitest';
import { closedOut } from './outcome';

describe('closedOut', () => {
  it('is true only when a status that ends the ticket was requested and the server changed it', () => {
    expect(closedOut({ statusChanged: true }, 4)).toBe(true);
  });

  it('is false when the status change failed, so the ticket stays and nothing is claimed', () => {
    expect(closedOut({ statusChanged: false }, 4)).toBe(false);
    expect(closedOut(undefined, 4)).toBe(false);
  });

  it('is false for a live status or no status', () => {
    expect(closedOut({ statusChanged: true }, 2)).toBe(false);
    expect(closedOut({ statusChanged: true }, null)).toBe(false);
  });
});
