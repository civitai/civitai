import { describe, expect, it, vi } from 'vitest';
import { isSameRemovalReason } from '@civitai/db-queries/image-removal-confirmation';

vi.mock('$lib/server/db', () => ({ dbWrite: {}, dbRead: {} }));
vi.mock('../clickhouse', () => ({ getClickhouse: () => ({}) }));

const { COMPARABLE_REASONS } = await import('../removal-hold');

// A likeness request says who asked, not what the image showed: it must hold a re-removal exactly as
// 'other' did before it had a type, never be read as a different reason that lets one through.
describe('removal hold — likeness requests', () => {
  it.each(['realPerson', 'likenessRequest', 'other'])(
    'holds a likeness-request re-removal of an image whose %s removal was overturned',
    (overturned) => {
      expect(isSameRemovalReason(overturned, 'likenessRequest', COMPARABLE_REASONS)).toBe(true);
    }
  );

  it('still tells two different known reasons apart (control)', () => {
    expect(isSameRemovalReason('realPerson', 'gore', COMPARABLE_REASONS)).toBe(false);
  });
});
