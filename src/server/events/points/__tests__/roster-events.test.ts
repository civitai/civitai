import { describe, expect, it, vi } from 'vitest';

const { events } = vi.hoisted(() => ({ events: [] as unknown[] }));
vi.mock('~/server/events/load-events', () => ({ loadEvents: async () => events }));

const { rosterEvents } = await import('~/server/events/points/roster-sync');

const join = { claimKey: 'claimed', design: 'basic' };
const event = (over: object) => ({
  name: 'birthday2026',
  previewFrom: new Date('2026-10-10T00:00:00.000Z'),
  startDate: new Date('2026-11-01T00:00:00.000Z'),
  endDate: new Date('2026-12-01T00:00:00.000Z'),
  teams: ['Blue'],
  scoring: {},
  join,
  ...over,
});

// The events whose rosters a ban, an opt-out or the reconcile may write. A roster stays readable
// after its event ends, so the end is no limit: a ban then must still take the member off it.
describe('rosterEvents', () => {
  it('includes an event from its preview on, and long after its end', async () => {
    events.splice(0, events.length, event({}));
    expect(await rosterEvents(new Date('2026-10-09T00:00:00.000Z'))).toEqual([]);
    expect((await rosterEvents(new Date('2026-10-20T00:00:00.000Z'))).map((e) => e.name)).toEqual([
      'birthday2026',
    ]);
    expect((await rosterEvents(new Date('2027-06-01T00:00:00.000Z'))).map((e) => e.name)).toEqual([
      'birthday2026',
    ]);
  });

  it('leaves out events with no join or no scoring', async () => {
    events.splice(0, events.length, event({ join: undefined }), event({ scoring: undefined }));
    expect(await rosterEvents(new Date('2026-11-05T00:00:00.000Z'))).toEqual([]);
  });
});
