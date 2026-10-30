import { beforeEach, describe, expect, it, vi } from 'vitest';

const execute = vi.fn();
const withModerators = vi.fn();

vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['selectFrom', 'select', 'where']) chain[m] = () => chain;
  chain.execute = () => execute();
  return { dbRead: chain };
});
vi.mock('../mod-activity', () => ({
  withModerators: (...a: unknown[]) => withModerators(...a),
}));

const { sentByTickets } = await import('../tickets/sent-by');

beforeEach(() => {
  execute.mockReset();
  withModerators.mockReset();
});

describe('sentByTickets', () => {
  it('names the moderator who sent each ticket', async () => {
    execute.mockResolvedValue([{ entityId: 5, userId: 4, createdAt: new Date('2026-10-02') }]);
    withModerators.mockImplementation(
      async (rows: { ticketId: string; userId: number; at: string }[]) =>
        rows.map((r) => ({
          ticketId: r.ticketId,
          moderatorId: r.userId,
          moderatorUsername: 'alice',
          at: r.at,
        }))
    );
    const res = await sentByTickets(['5']);
    expect(res.get('5')).toMatchObject({ moderatorId: 4, username: 'alice' });
  });

  it('rejects when the read fails, so the caller can say who-sent is missing', async () => {
    execute.mockRejectedValue(new Error('moderator db down'));
    await expect(sentByTickets(['5'])).rejects.toThrow('moderator db down');
  });
});
