import { describe, it, expect } from 'vitest';
import { reviveAnnouncementsSeed } from '~/providers/announcements-seed';

// A realistic SSR-serialized announcement: the way the seed arrives on the
// client via Next pageProps (JSON.stringify turns Dates into ISO strings).
const serialized = {
  id: 1,
  title: 'Heads up',
  content: '<p>hello</p>',
  color: 'blue',
  emoji: '📣',
  metadata: { targetAudience: 'all' as const },
  createdAt: '2026-06-01T00:00:00.000Z',
  startsAt: '2026-06-02T00:00:00.000Z',
  endsAt: '2026-06-10T00:00:00.000Z',
};

describe('reviveAnnouncementsSeed', () => {
  it('returns undefined for an undefined seed (so the query self-heals via a live fetch)', () => {
    expect(reviveAnnouncementsSeed(undefined)).toBeUndefined();
  });

  it('returns an empty array for an empty seed (no active announcements)', () => {
    expect(reviveAnnouncementsSeed([] as never)).toEqual([]);
  });

  it('revives ISO-string date fields into Date objects', () => {
    const [revived] = reviveAnnouncementsSeed([serialized] as never)!;
    expect(revived.createdAt).toBeInstanceOf(Date);
    expect(revived.startsAt).toBeInstanceOf(Date);
    expect(revived.endsAt).toBeInstanceOf(Date);
    expect((revived.createdAt as Date).toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect((revived.startsAt as Date).toISOString()).toBe('2026-06-02T00:00:00.000Z');
    expect((revived.endsAt as Date).toISOString()).toBe('2026-06-10T00:00:00.000Z');
  });

  it('preserves a null endsAt as null (never-ending announcement)', () => {
    const [revived] = reviveAnnouncementsSeed([{ ...serialized, endsAt: null }] as never)!;
    expect(revived.endsAt).toBeNull();
  });

  it('passes non-date fields through untouched', () => {
    const [revived] = reviveAnnouncementsSeed([serialized] as never)!;
    expect(revived.id).toBe(1);
    expect(revived.title).toBe('Heads up');
    expect(revived.content).toBe('<p>hello</p>');
    expect(revived.color).toBe('blue');
    expect(revived.emoji).toBe('📣');
    expect(revived.metadata).toEqual({ targetAudience: 'all' });
  });

  it('is idempotent on values that already hold Date objects (a live refetch shape)', () => {
    const live = {
      ...serialized,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
      startsAt: new Date('2026-06-02T00:00:00.000Z'),
      endsAt: new Date('2026-06-10T00:00:00.000Z'),
    };
    const [revived] = reviveAnnouncementsSeed([live] as never)!;
    expect(revived.createdAt).toBeInstanceOf(Date);
    expect((revived.createdAt as Date).toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect((revived.endsAt as Date).toISOString()).toBe('2026-06-10T00:00:00.000Z');
  });
});
