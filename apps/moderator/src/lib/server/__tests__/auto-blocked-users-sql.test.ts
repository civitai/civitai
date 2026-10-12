import { describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => [] as string[]);
const capturedParams = vi.hoisted(() => [] as unknown[][]);

vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  const db = capturingDb(captured, [], capturedParams);
  return { dbRead: db, dbWrite: db };
});
vi.mock('../cache', () => ({ createCache: () => ({ get: vi.fn(), bust: vi.fn() }) }));
vi.mock('../moderator-db', () => ({ getModeratorDb: vi.fn() }));

const { getAutoBlockedUsers } = await import('../moderation-board.service');

const compile = async () => {
  captured.length = 0;
  capturedParams.length = 0;
  await getAutoBlockedUsers();
  expect(captured).toHaveLength(1);
  return { sql: captured[0], params: capturedParams[0] };
};

describe('getAutoBlockedUsers SQL', () => {
  it('reaches the ledger only through a lateral, so a user with several cases stays one row', async () => {
    const { sql } = await compile();
    expect(sql).not.toMatch(/left join "UserRestriction"/);
    expect(sql).toMatch(/left join lateral \(select[\s\S]*?from "UserRestriction"/);
  });

  it('picks the scam case the mute opened, not a later one', async () => {
    const { sql, params } = await compile();
    const lateral = sql.slice(sql.indexOf('from "UserRestriction"'));
    expect(lateral).toContain(`ur."userId" = ma."entityId"`);
    expect(lateral).toContain(`ur."createdAt" <= ma."createdAt"`);
    const type = /"ur"\."type" = \$(\d+)/.exec(lateral);
    expect(type).not.toBeNull();
    expect(params[Number(type![1]) - 1]).toBe('scam');
    expect(lateral).toMatch(/order by "ur"\."createdAt" desc/);
    const limit = /limit \$(\d+)/.exec(lateral);
    expect(params[Number(limit![1]) - 1]).toBe(1);
  });

  it('reads the reason and entity from the first trigger', async () => {
    const { sql } = await compile();
    expect(sql).toContain(`ur.triggers -> 0 ->> 'reason'`);
    expect(sql).toContain(`ur.triggers -> 0 ->> 'entityType'`);
    expect(sql).toContain(`(ur.triggers -> 0 ->> 'entityId')::int`);
    expect(sql).toMatch(/"scan"\."reason" as "scanReason"/);
    expect(sql).toMatch(/"scan"\."entityType" as "scanEntityType"/);
    expect(sql).toMatch(/"scan"\."entityId" as "scanEntityId"/);
    expect(sql).toMatch(/"scan"\."status" as "restrictionStatus"/);
  });

  it('never reads EntityModeration', async () => {
    expect((await compile()).sql).not.toContain('"EntityModeration"');
  });
});
