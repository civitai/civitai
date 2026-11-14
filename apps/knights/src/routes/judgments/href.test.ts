import { describe, expect, it } from 'vitest';
import { judgmentsHref } from './href';

describe('judgmentsHref', () => {
  it('keeps the status filter when paging', () => {
    expect(judgmentsHref('wrong', 3)).toBe('/judgments?status=wrong&page=3');
    expect(judgmentsHref('wrong', 1)).toBe('/judgments?status=wrong');
  });

  it('leaves the defaults out', () => {
    expect(judgmentsHref('all', 1)).toBe('/judgments');
    expect(judgmentsHref('all', 2)).toBe('/judgments?page=2');
  });
});
