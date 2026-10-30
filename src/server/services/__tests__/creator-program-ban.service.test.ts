import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Booting PGlite (WASM Postgres) can exceed the default hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { refreshSession } = vi.hoisted(() => ({
  refreshSession: vi.fn<(...a: unknown[]) => Promise<void>>(async () => undefined),
}));
vi.mock('~/server/auth/session-invalidation', () => ({
  refreshSession: (...a: unknown[]) => refreshSession(...a),
}));

import { setCreatorProgramBan } from '~/server/services/creator-program-ban.service';

/**
 * Runs the ban's SQL and its ModActivity insert unmodified on an in-process Postgres, so the bit
 * arithmetic is Postgres's, not a fake's.
 */

const holder = { db: null as unknown as PGlite, failAudit: false };
const tx = {
  $queryRawUnsafe: async (sql: string, ...params: unknown[]) =>
    (await holder.db.query(sql, params)).rows,
  // trackModActivity's tagged template, numbered the way Prisma numbers it.
  $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (holder.failAudit) throw new Error('ModActivity insert failed');
    // Prisma sends an int array typed; PGlite needs the cast to resolve UNNEST's overload.
    const text = strings
      .reduce((acc, part, i) => `${acc}$${i}${part}`)
      .replace(/UNNEST\((\$\d+)\)/, 'UNNEST($1::int[])');
    return (await holder.db.query(text, values)).affectedRows ?? 0;
  },
};
// Rolls back on a throw, as Prisma's interactive transaction does.
const client = {
  $transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => {
    await holder.db.exec('BEGIN');
    try {
      const result = await fn(tx);
      await holder.db.exec('COMMIT');
      return result;
    } catch (e) {
      await holder.db.exec('ROLLBACK');
      throw e;
    }
  },
} as never;

const TARGET = 8675309;
const MODERATOR = 990000007;

async function onboarding(userId = TARGET) {
  const [row] = (
    await holder.db.query<{ onboarding: number }>(`SELECT onboarding FROM "User" WHERE id = $1`, [
      userId,
    ])
  ).rows;
  return row.onboarding;
}
async function activities() {
  return (
    await holder.db.query<{
      userId: number;
      entityType: string;
      entityId: number;
      activity: string;
    }>(`SELECT "userId", "entityType", "entityId", activity FROM "ModActivity" ORDER BY id`)
  ).rows;
}
const ban = (action: 'set' | 'clear', extra: { reason?: string; gateRef?: string } = {}) =>
  setCreatorProgramBan(
    { userId: TARGET, action, reason: 'Counterparty farming', moderatorId: MODERATOR, ...extra },
    client
  );

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY, onboarding int NOT NULL DEFAULT 0);
    CREATE TABLE "ModActivity" (
      id serial PRIMARY KEY, "userId" int, activity text NOT NULL, "entityType" text,
      "entityId" int, "createdAt" timestamp NOT NULL DEFAULT now()
    );
  `);
});

async function seed(value: number) {
  await holder.db.exec(`TRUNCATE "ModActivity"; DELETE FROM "User";`);
  await holder.db.query(`INSERT INTO "User" (id, onboarding) VALUES ($1, $2), ($3, 15)`, [
    TARGET,
    value,
    MODERATOR,
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  holder.failAudit = false;
});

describe('setCreatorProgramBan: only the ban bit moves', () => {
  it.each([
    ['set on a fully onboarded account', 'set', 15, 47],
    ['clear on a banned account', 'clear', 47, 15],
    ['clear keeps every other bit, CreatorProgram and RedTOS included', 'clear', 127, 95],
    ['clear on 63', 'clear', 63, 31],
    ['set on 0', 'set', 0, 32],
  ] as const)('%s', async (_label, action, before, after) => {
    await seed(before);
    const result = await ban(action);
    expect(await onboarding()).toBe(after);
    expect(result).toEqual({ userId: TARGET, action, before, after, changed: true });
    // Another account is untouched.
    expect(await onboarding(MODERATOR)).toBe(15);
  });
});

describe('setCreatorProgramBan: repeating a call', () => {
  it.each([
    ['set on an already-banned account', 'set', 47],
    ['clear on an account that is not banned', 'clear', 15],
  ] as const)(
    '%s changes nothing, still audits, and does not refresh the session',
    async (_l, action, value) => {
      await seed(value);
      const result = await ban(action);
      expect(await onboarding()).toBe(value);
      expect(result).toMatchObject({ before: value, after: value, changed: false });
      expect(await activities()).toHaveLength(1);
      expect(refreshSession).not.toHaveBeenCalled();
    }
  );

  it('control: a change refreshes the target account’s session', async () => {
    await seed(15);
    await ban('set');
    expect(refreshSession).toHaveBeenCalledWith(TARGET, { caller: 'moderation' });
  });
});

describe('setCreatorProgramBan: the audit row', () => {
  it('records actor, target, before/after, reason and gateRef', async () => {
    await seed(15);
    await ban('set', { gateRef: 'hub:request:abc123' });
    expect(await activities()).toEqual([
      {
        userId: MODERATOR,
        entityType: 'user',
        entityId: TARGET,
        activity:
          'creatorProgramBan:set:15:47:{"reason":"Counterparty farming","gateRef":"hub:request:abc123"}',
      },
    ]);
  });

  it('a reason full of colons round-trips intact, and the fields before it stay put', async () => {
    await seed(47);
    const reason = 'Appeal: approved: see ticket 12:30 "quoted"';
    await ban('clear', { reason, gateRef: 'hub:request:x:y' });
    const [{ activity }] = await activities();
    const [prefix, verb, before, after] = activity.split(':', 4);
    expect([prefix, verb, before, after]).toEqual(['creatorProgramBan', 'clear', '47', '15']);
    const tail = activity.slice(`${prefix}:${verb}:${before}:${after}:`.length);
    expect(JSON.parse(tail)).toEqual({ reason, gateRef: 'hub:request:x:y' });
  });

  it('records gateRef as null when none is given', async () => {
    await seed(15);
    await ban('set');
    const [{ activity }] = await activities();
    expect(activity.endsWith('"gateRef":null}')).toBe(true);
  });
});

describe('setCreatorProgramBan: refusals write nothing', () => {
  it('a blank reason is refused before the transaction', async () => {
    await seed(15);
    await expect(ban('set', { reason: '   ' })).rejects.toThrow('A reason is required.');
    expect(await onboarding()).toBe(15);
    expect(await activities()).toHaveLength(0);
  });

  it('an unknown account is a not-found with no audit row', async () => {
    await seed(15);
    await expect(
      setCreatorProgramBan(
        { userId: 1, action: 'set', reason: 'x', moderatorId: MODERATOR },
        client
      )
    ).rejects.toThrow('No user with id 1.');
    expect(await activities()).toHaveLength(0);
  });

  it('a 501-char reason is refused', async () => {
    await seed(15);
    await expect(ban('set', { reason: 'x'.repeat(501) })).rejects.toThrow('longer than 500');
    expect(await onboarding()).toBe(15);
    expect(await activities()).toHaveLength(0);
  });

  it.each(['set', 'clear'] as const)(
    'a moderator cannot %s the ban on their own account',
    async (action) => {
      await seed(47);
      await expect(
        setCreatorProgramBan(
          { userId: MODERATOR, action, reason: 'x', moderatorId: MODERATOR },
          client
        )
      ).rejects.toThrow('your own account');
      expect(await onboarding(MODERATOR)).toBe(15);
      expect(await activities()).toHaveLength(0);
    }
  );

  it('a ban that cannot be audited is not written', async () => {
    await seed(15);
    holder.failAudit = true;
    await expect(ban('set')).rejects.toThrow('ModActivity insert failed');
    expect(await onboarding()).toBe(15);
    expect(await activities()).toHaveLength(0);
    expect(refreshSession).not.toHaveBeenCalled();
  });
});

describe('setCreatorProgramBan: a failed session refresh', () => {
  it('still returns the committed change', async () => {
    await seed(15);
    refreshSession.mockRejectedValueOnce(new Error('hub unreachable'));
    await expect(ban('set')).resolves.toMatchObject({ before: 15, after: 47, changed: true });
    expect(await onboarding()).toBe(47);
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });
});
