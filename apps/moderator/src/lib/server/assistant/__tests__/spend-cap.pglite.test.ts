import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../../test/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executableSchemaSql, pgliteDialect } from '../../__tests__/abuse-detection-pglite.harness';

/**
 * The dollar cap's rows, against `apps/moderator/assistant/schema.sql` in an in-process Postgres: what a
 * day costs, and that no cap changes without its history row.
 */

const SCHEMA = join(dirname(fileURLToPath(import.meta.url)), '../../../../../assistant/schema.sql');

let pg: PGlite;
let kysely: Kysely<unknown>;
vi.mock('$lib/server/moderator-db', () => ({ getModeratorDb: () => kysely }));

const store = await import('../store');
const caps = await import('../spend-cap');

beforeEach(async () => {
  pg = await freshPglite();
  await pg.exec(executableSchemaSql(readFileSync(SCHEMA, 'utf8')));
  kysely = new Kysely({ dialect: pgliteDialect(pg) });
});
afterEach(async () => {
  await pg.close();
});

async function turn(
  moderatorId: number,
  tokens: { prompt: number; completion: number },
  cost: { usd: number; source: 'live' | 'list' } | null
) {
  const chatId = await store.createChat({
    moderatorId,
    title: 'c',
    seedUserId: null,
    seedReportId: null,
  });
  const turnId = await store.startTurn({
    chatId,
    moderatorId,
    prompt: 'q',
    playbookSlug: null,
    playbookVersion: null,
    model: 'm',
  });
  const outcome = {
    status: 'done' as const,
    toolCalls: [],
    sources: [],
    answer: 'a',
    reasoning: null,
    unverified: [],
    error: null,
    promptTokens: tokens.prompt,
    completionTokens: tokens.completion,
  };
  await store.finishTurn(turnId, outcome, cost ?? { usd: 0, source: 'list' });
  if (!cost) await pg.query(`UPDATE assistant_turn SET cost_usd = NULL WHERE id = $1`, [turnId]);
  return turnId;
}

describe('usdToday', () => {
  it("sums this moderator's recorded costs since midnight UTC", async () => {
    await turn(1, { prompt: 1, completion: 1 }, { usd: 0.25, source: 'live' });
    await turn(1, { prompt: 1, completion: 1 }, { usd: 0.5, source: 'list' });
    await turn(2, { prompt: 1, completion: 1 }, { usd: 9, source: 'list' });
    const old = await turn(1, { prompt: 1, completion: 1 }, { usd: 9, source: 'list' });
    await pg.query(
      `UPDATE assistant_turn SET created_at = now() - interval '2 days' WHERE id = $1`,
      [old]
    );
    expect(await store.usdToday(1)).toBe(0.75);
  });

  it('charges a turn whose process died at its recorded tokens, at the dearest listed price', async () => {
    const chatId = await store.createChat({
      moderatorId: 1,
      title: 'c',
      seedUserId: null,
      seedReportId: null,
    });
    const turnId = await store.startTurn({
      chatId,
      moderatorId: 1,
      prompt: 'q',
      playbookSlug: null,
      playbookVersion: null,
      model: 'm',
    });
    await store.recordTurnTokens(turnId, 1_000_000, 1_000_000);
    // Abandoned by moving the app's clock past the stale window, not by backdating the row: a backdated
    // row falls into yesterday in the first UTC hours, and the day's sum then never sees it.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 60 * 60_000 });
    try {
      expect(await store.hasRunningTurn(1, 60_000)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    expect(await store.usdToday(1)).toBeCloseTo(3.7, 10);
  });

  it('keeps a finished turn’s own record over a late token update', async () => {
    const turnId = await turn(1, { prompt: 10, completion: 10 }, { usd: 0.25, source: 'live' });
    await store.recordTurnTokens(turnId, 1_000_000, 1_000_000);
    expect(await store.usdToday(1)).toBe(0.25);
    expect(await store.tokensToday(1)).toBe(20);
  });

  it('charges a turn with no recorded cost at the dearest listed price', async () => {
    await turn(1, { prompt: 1_000_000, completion: 1_000_000 }, null);
    expect(await store.usdToday(1)).toBeCloseTo(3.7, 10);
  });
});

describe('changeSpendCap', () => {
  const change = (over: Partial<Parameters<typeof caps.changeSpendCap>[0]> = {}) =>
    caps.changeSpendCap({
      scope: 'user',
      subject: '7',
      usd: 2.5,
      expect: null,
      actorId: 1,
      reason: 'pilot',
      ...over,
    });

  it('writes the cap and its history row, and removes it the same way', async () => {
    expect(await change()).toEqual({ changed: true });
    expect(await caps.capsFor({ id: 7, roles: [] })).toEqual([
      { scope: 'user', subject: '7', usd: 2.5 },
    ]);
    expect(await change({ usd: null, expect: 2.5 })).toEqual({ changed: true });
    expect(await caps.capsFor({ id: 7, roles: [] })).toEqual([]);
    expect(
      (await caps.listSpendCapChanges(10)).map((c) => [c.actorId, c.before, c.after, c.reason])
    ).toEqual([
      [1, 2.5, null, 'pilot'],
      [1, null, 2.5, 'pilot'],
    ]);
  });

  it('stores a $0 cap', async () => {
    await change({ usd: 0 });
    expect(await caps.capsFor({ id: 7, roles: [] })).toEqual([
      { scope: 'user', subject: '7', usd: 0 },
    ]);
  });

  it('changes nothing when the history row cannot be written', async () => {
    await change();
    await pg.exec('DROP TABLE assistant_spend_cap_change');
    for (const attempt of [
      { subject: '8', usd: 3, expect: null }, // add
      { subject: '7', usd: 4, expect: 2.5 }, // change
      { subject: '7', usd: null, expect: 2.5 }, // remove
    ])
      await expect(change(attempt)).rejects.toBeInstanceOf(caps.SpendCapUnavailableError);
    expect(await caps.listSpendCaps()).toEqual([{ scope: 'user', subject: '7', usd: 2.5 }]);
  });

  it('refuses a change to a cap that moved since it was read', async () => {
    await change();
    await expect(change({ usd: 4, expect: null })).rejects.toBeInstanceOf(
      caps.SpendCapConflictError
    );
    expect((await caps.capsFor({ id: 7, roles: [] }))[0].usd).toBe(2.5);
    expect(await caps.listSpendCapChanges(10)).toHaveLength(1);
  });

  it("reads only the moderator's own row and their roles' rows", async () => {
    await change({ scope: 'role', subject: 'moderator:a', usd: 3 });
    await change({ scope: 'role', subject: 'moderator:b', usd: 4 });
    await change({ subject: '8', usd: 5 });
    expect(await caps.capsFor({ id: 7, roles: ['moderator:a'] })).toEqual([
      { scope: 'role', subject: 'moderator:a', usd: 3 },
    ]);
  });
});
