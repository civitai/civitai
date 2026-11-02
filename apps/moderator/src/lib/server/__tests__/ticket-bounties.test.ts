import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));

const { bountiesSectionFor } = await import('../tickets/bounties');

const bounties = vi.fn();
const entries = vi.fn();
const reads = {
  bounties: (...a: unknown[]) => bounties(...a),
  entries: (...a: unknown[]) => entries(...a),
} as never;

const bounty = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  name: `Bounty ${id}`,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  expiresAt: new Date('2026-12-01T00:00:00Z'),
  complete: false,
  type: 'ModelCreation',
  description: 'free text',
  unitAmount: 3000,
  ...over,
});
const entry = (id: number) => ({
  id,
  bountyId: id * 10,
  bountyName: `Other ${id}`,
  createdAt: new Date('2026-10-02T00:00:00Z'),
  description: 'free text',
});

beforeEach(() => {
  bounties.mockReset().mockResolvedValue({ items: [bounty(1)], truncated: false });
  entries.mockReset().mockResolvedValue({ items: [entry(2)], truncated: false });
});

describe('bountiesSectionFor', () => {
  it('lists the bounties the user funded and the entries they submitted', async () => {
    bounties.mockResolvedValue({ items: [bounty(1, { complete: true })], truncated: false });
    const res = await bountiesSectionFor({ userId: 7 }, reads);
    expect(bounties).toHaveBeenCalledWith(7, 10);
    expect(entries).toHaveBeenCalledWith(7, 10);
    expect(res).toEqual({
      status: 'ok',
      userId: 7,
      bounties: {
        status: 'ok',
        truncated: false,
        rows: [
          {
            id: 1,
            name: 'Bounty 1',
            type: 'ModelCreation',
            complete: true,
            pledged: 3000,
            createdAt: '2026-10-01T00:00:00.000Z',
            expiresAt: '2026-12-01T00:00:00.000Z',
          },
        ],
      },
      entries: {
        status: 'ok',
        truncated: false,
        rows: [
          { id: 2, bountyId: 20, bountyName: 'Other 2', createdAt: '2026-10-02T00:00:00.000Z' },
        ],
      },
    });
  });

  it('does not carry the free-text descriptions', async () => {
    expect(JSON.stringify(await bountiesSectionFor({ userId: 7 }, reads))).not.toContain(
      'free text'
    );
  });

  it('says when either list was cut', async () => {
    bounties.mockResolvedValue({ items: [bounty(1)], truncated: true });
    expect(await bountiesSectionFor({ userId: 7 }, reads)).toMatchObject({
      bounties: { truncated: true },
      entries: { truncated: false },
    });
  });

  it('turns one failing read into that sections unavailable, leaving the other', async () => {
    entries.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await bountiesSectionFor({ userId: 7 }, reads)).toMatchObject({
      status: 'ok',
      bounties: { status: 'ok' },
      entries: { status: 'unavailable' },
    });
  });
});
