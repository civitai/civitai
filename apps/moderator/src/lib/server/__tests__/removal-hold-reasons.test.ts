import { describe, expect, it, vi } from 'vitest';
import { isSameRemovalReason } from '@civitai/db-queries/image-removal-confirmation';

vi.mock('$lib/server/db', () => ({ dbWrite: {}, dbRead: {} }));
vi.mock('../clickhouse', () => ({ getClickhouse: () => ({}) }));

const { COMPARABLE_REASONS } = await import('../removal-hold');

// A likeness request says who asked, not what the image showed: it must hold a re-removal as 'other'
// does, never be read as a different reason that lets one through.
describe('removal hold — likeness requests', () => {
  // Each row differs from a known reason, so only the exclusion holds it.
  it.each([
    ['realPerson', 'likenessRequest'],
    ['gore', 'likenessRequest'],
    ['likenessRequest', 'realPerson'],
  ])('holds a %s removal overturned, then re-removed as %s', (overturned, requested) => {
    expect(isSameRemovalReason(overturned, requested, COMPARABLE_REASONS)).toBe(true);
  });

  it('still tells two different known reasons apart (control)', () => {
    expect(isSameRemovalReason('realPerson', 'gore', COMPARABLE_REASONS)).toBe(false);
  });
});
