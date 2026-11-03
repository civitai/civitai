import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));

const { historySectionFor, HISTORY_ROWS } = await import('../tickets/history');

const strikes = vi.fn();
const notes = vi.fn();
const activity = vi.fn();
const removals = vi.fn();
const reads = {
  strikes: (...a: unknown[]) => strikes(...a),
  notes: (...a: unknown[]) => notes(...a),
  activity: (...a: unknown[]) => activity(...a),
  removals: (...a: unknown[]) => removals(...a),
} as never;

const strike = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  reason: 'TOSViolation',
  description: 'internal wording',
  points: 1,
  status: 'Active',
  createdAt: new Date('2026-10-01T00:00:00Z'),
  expiresAt: new Date('2026-11-01T00:00:00Z'),
  voidedAt: null,
  issuedBy: 4,
  issuedByName: 'mod',
  imported: false,
  ...over,
});
const removal = (i: number, over: Record<string, unknown> = {}) => ({
  key: `k${i}`,
  type: 'DeleteTOS',
  at: '2026-10-02T00:00:00Z',
  imageId: i,
  actorId: 4,
  actorUsername: 'mod',
  actorIsModerator: true,
  tosReason: 'Nudity',
  violationType: null,
  ...over,
});

beforeEach(() => {
  strikes.mockReset().mockResolvedValue([strike(1)]);
  notes.mockReset().mockResolvedValue([
    {
      id: 9,
      notes: 'watch this one',
      lastUpdate: new Date('2026-09-01T00:00:00Z'),
      lastUpdateBy: 'mod',
      isMine: false,
    },
  ]);
  activity.mockReset().mockResolvedValue([
    {
      id: 3,
      activity: 'removeContent',
      entityType: 'Image',
      entityId: 5,
      createdAt: new Date('2026-10-03T00:00:00Z'),
      moderatorId: 4,
      moderatorUsername: 'mod',
    },
  ]);
  removals.mockReset().mockResolvedValue({ rows: [removal(1)], next: null, counts: {} });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('historySectionFor', () => {
  it('reads each source for the linked user, one row over the cap, and shapes plain rows', async () => {
    const res = await historySectionFor({ userId: 7 }, reads);
    expect(strikes).toHaveBeenCalledWith(7, HISTORY_ROWS + 1);
    expect(notes).toHaveBeenCalledWith(7);
    expect(activity).toHaveBeenCalledWith(7, HISTORY_ROWS + 1);
    expect(removals).toHaveBeenCalledWith(7, HISTORY_ROWS);
    expect(res).toMatchObject({
      status: 'ok',
      userId: 7,
      strikes: {
        status: 'ok',
        truncated: false,
        rows: [{ id: 1, reason: 'TOSViolation', issuedByName: 'mod' }],
      },
      notes: { status: 'ok', rows: [{ id: 9, text: 'watch this one', by: 'mod' }] },
      activity: { status: 'ok', rows: [{ id: 3, activity: 'removeContent', entityId: 5 }] },
      removals: { status: 'ok', rows: [{ imageId: 1, type: 'DeleteTOS' }] },
    });
  });

  it('never carries a strike’s free-text description', async () => {
    const res = await historySectionFor({ userId: 7 }, reads);
    expect(JSON.stringify(res)).not.toContain('internal wording');
  });

  it('cuts every section to the cap and says it was cut', async () => {
    strikes.mockResolvedValue(Array.from({ length: HISTORY_ROWS + 1 }, (_, i) => strike(i + 1)));
    notes.mockResolvedValue(
      Array.from({ length: HISTORY_ROWS + 3 }, (_, i) => ({
        id: i,
        notes: 'n',
        lastUpdate: null,
        lastUpdateBy: null,
        isMine: false,
      }))
    );
    removals.mockResolvedValue({
      rows: Array.from({ length: HISTORY_ROWS }, (_, i) => removal(i + 1)),
      next: { at: 'x', imageId: 1 },
      counts: {},
    });
    const res = (await historySectionFor({ userId: 7 }, reads)) as never as Record<string, any>;
    expect(res.strikes.rows).toHaveLength(HISTORY_ROWS);
    expect(res.strikes.truncated).toBe(true);
    expect(res.notes.rows).toHaveLength(HISTORY_ROWS);
    expect(res.notes.truncated).toBe(true);
    expect(res.removals.truncated).toBe(true);
    expect(res.activity.truncated).toBe(false);
  });

  it('drops an image removal filed under a CSAM reason, whichever field carries it', async () => {
    removals.mockResolvedValue({
      rows: [
        removal(1, { tosReason: 'CSAM' }),
        removal(2, { violationType: 'csam-suspected' }),
        removal(3),
      ],
      next: null,
      counts: {},
    });
    const res = (await historySectionFor({ userId: 7 }, reads)) as never as Record<string, any>;
    expect(res.removals.rows.map((r: { imageId: number }) => r.imageId)).toEqual([3]);
  });

  it('shows a failing section as unavailable while the others still render', async () => {
    strikes.mockRejectedValue(new Error('db down'));
    removals.mockRejectedValue(new Error('clickhouse down'));
    const res = (await historySectionFor({ userId: 7 }, reads)) as never as Record<string, any>;
    expect(res.status).toBe('ok');
    expect(res.strikes).toEqual({ status: 'unavailable' });
    expect(res.removals).toEqual({ status: 'unavailable' });
    expect(res.notes.status).toBe('ok');
    expect(res.activity.status).toBe('ok');
  });
});
