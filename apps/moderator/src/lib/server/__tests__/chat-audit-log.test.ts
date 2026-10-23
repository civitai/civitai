import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyGrants, canAccess } from '../access';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../clickhouse', () => ({ getClickhouse: () => ({ query }) }));
vi.mock('../users.service', async () => ({
  usersByIds: async () => new Map([[9, { username: 'mod' }]]),
  isInt4Id: () => true,
  MAX_INT4: 2_147_483_647,
}));

const { getChatAuditEvents } = await import('../chat-audit-log.service');

const row = (createdAt: string, chatId = 4) => ({
  createdAt,
  type: 'read',
  chatId,
  messageId: 0,
  actorId: 9,
  subjectId: 0,
  actorRole: 'moderator',
});
const returning = (rows: unknown[]) => query.mockResolvedValue({ json: async () => rows });

beforeEach(() => query.mockReset());

describe('getChatAuditEvents', () => {
  // Decided: the log page shows no message text. Reading it there would be reading DMs without the
  // read itself being recorded; the transcript shows the text and records the read. Keep it out.
  it('never selects message text', async () => {
    returning([]);
    await getChatAuditEvents({}, 50);
    const sql: string = query.mock.calls[0][0].query;
    expect(sql).not.toMatch(/oldValue|newValue/);
  });

  it('binds every filter as a parameter, never into the SQL', async () => {
    returning([]);
    await getChatAuditEvents(
      {
        chatId: 4,
        actorId: 9,
        type: 'read',
        before: {
          at: '2026-10-01 10:00:00.000',
          chatId: 4,
          messageId: 0,
          actorId: 9,
          subjectId: 3,
          type: 'read',
        },
      },
      50
    );
    const { query: sql, query_params } = query.mock.calls[0][0];
    expect(sql).not.toContain('2026-10-01');
    expect(sql).not.toMatch(/=\s*\d|<\s*\(\s*'/);
    for (const p of ['{chatId:Int32}', '{actorId:Int32}', '{type:String}', '{bSubject:Int32}'])
      expect(sql).toContain(p);
    expect(query_params).toMatchObject({
      chatId: 4,
      actorId: 9,
      type: 'read',
      at: '2026-10-01 10:00:00.000',
    });
  });

  it('hands back a cursor only when there is another page, at the last row shown', async () => {
    returning([
      row('2026-10-01 10:00:02.000'),
      row('2026-10-01 10:00:01.000'),
      row('2026-10-01 10:00:00.000'),
    ]);
    const { events, next } = await getChatAuditEvents({}, 2);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ at: '2026-10-01T10:00:02.000Z', actorName: 'mod' });
    expect(next).toEqual({
      at: '2026-10-01 10:00:01.000',
      chatId: 4,
      messageId: 0,
      actorId: 9,
      subjectId: 0,
      type: 'read',
    });

    returning([row('2026-10-01 10:00:00.000')]);
    expect((await getChatAuditEvents({}, 2)).next).toBeNull();
  });
});

describe('Chat Audit Log access', () => {
  const user = (roles: string[]) => ({ roles });
  beforeEach(() => applyGrants({ '/retool/chat-audit': ['moderator:chat'] }));

  // Decided: it shows which moderator read whose DMs, so holding Chat Audit must not open it.
  it('is not opened by the Chat Audit grant', () => {
    expect(canAccess(user(['moderator:chat']), '/retool/chat-audit')).toBe(true);
    expect(canAccess(user(['moderator:chat']), '/retool/chat-audit-log')).toBe(false);
  });
});
