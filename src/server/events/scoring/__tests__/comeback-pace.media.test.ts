import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null, clickhouseLongQueries: null }));

const { getEventMedia } = await import('~/server/events/scoring/comeback-pace');

const serve = (raw: string | null) =>
  redisMock.sysRedis.get.mockImplementation((async () => raw) as never);

describe('getEventMedia', () => {
  beforeEach(() => {
    loggingMock.logToAxiom.mockClear();
  });

  it('returns the media field of the flagRace key', async () => {
    serve(
      JSON.stringify({
        days: [],
        media: { flagRace: { video: 'race-id', duration: 95 }, comeback: { video: 'cup-id' } },
      })
    );
    expect(await getEventMedia('birthday2026')).toEqual({
      flagRace: { video: 'race-id', duration: 95 },
      comeback: { video: 'cup-id' },
    });
  });

  it('gives no media when the key has none, or there is no key', async () => {
    serve(JSON.stringify({ days: [] }));
    expect(await getEventMedia('birthday2026')).toEqual({});
    serve(null);
    expect(await getEventMedia('birthday2026')).toEqual({});
    expect(loggingMock.logToAxiom).not.toHaveBeenCalled();
  });

  it('gives no media, and logs, when the media field is malformed', async () => {
    serve(JSON.stringify({ media: { flagRace: { video: '', duration: -1 } } }));
    expect(await getEventMedia('birthday2026')).toEqual({});
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'event-media-invalid', event: 'birthday2026' })
    );
  });

  it('gives no media when the flagRace key cannot be read or parsed', async () => {
    serve('{not json');
    expect(await getEventMedia('birthday2026')).toEqual({});
    redisMock.sysRedis.get.mockImplementation((async () => {
      throw new Error('sysRedis down');
    }) as never);
    expect(await getEventMedia('birthday2026')).toEqual({});
  });
});
