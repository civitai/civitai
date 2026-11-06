import {
  moderatorDbStatus,
  storeUnavailableMessage,
  type ModeratorDbStatus,
} from '$lib/moderator-db-status';
import { getModeratorDb } from '../moderator-db';
import type { AssistantTables, SpendCapScope } from './tables';

/** USD per UTC day for a moderator with no cap of their own and none on any of their roles. */
export const DEFAULT_DAILY_USD = 1;
/** `numeric(8, 2)`. */
export const MAX_DAILY_USD = 999_999.99;

const db = () => getModeratorDb().withTables<AssistantTables>();

export type SpendCap = { scope: SpendCapScope; subject: string; usd: number };

/**
 * A moderator's daily cap: their own row, else the highest among their roles, else the default. Their
 * own row wins in both directions, so a $0 row turns the assistant off for them whatever a role grants.
 */
export function resolveDailyCap(
  caps: readonly SpendCap[],
  moderator: { id: number; roles: readonly string[] }
): { usd: number; from: 'user' | 'role' | 'default' } {
  const own = caps.find((c) => c.scope === 'user' && c.subject === String(moderator.id));
  if (own) return { usd: own.usd, from: 'user' };
  const roleCaps = caps
    .filter((c) => c.scope === 'role' && moderator.roles.includes(c.subject))
    .map((c) => c.usd);
  if (roleCaps.length) return { usd: Math.max(...roleCaps), from: 'role' };
  return { usd: DEFAULT_DAILY_USD, from: 'default' };
}

export async function capsFor(moderator: {
  id: number;
  roles: readonly string[];
}): Promise<SpendCap[]> {
  const rows = await db()
    .selectFrom('assistant_spend_cap')
    .select(['scope', 'subject', 'usd_per_day'])
    .where((eb) =>
      eb.or([
        eb.and([eb('scope', '=', 'user'), eb('subject', '=', String(moderator.id))]),
        ...(moderator.roles.length
          ? [eb.and([eb('scope', '=', 'role'), eb('subject', 'in', [...moderator.roles])])]
          : []),
      ])
    )
    .execute();
  return rows.map(toCap);
}

export async function listSpendCaps(): Promise<SpendCap[]> {
  const rows = await db()
    .selectFrom('assistant_spend_cap')
    .select(['scope', 'subject', 'usd_per_day'])
    .orderBy('scope')
    .orderBy('subject')
    .execute();
  return rows.map(toCap);
}

const toCap = (r: { scope: SpendCapScope; subject: string; usd_per_day: string }): SpendCap => ({
  scope: r.scope,
  subject: r.subject,
  usd: Number(r.usd_per_day),
});

export const spendCapUnavailableMessage = (status: Exclude<ModeratorDbStatus, 'ok'>) =>
  storeUnavailableMessage(status, {
    tables: 'The assistant spend cap tables',
    database: 'the moderator database',
    schemaFile: 'apps/moderator/assistant/schema.sql',
  });

/** The cap moved after the caller read it. Nothing was written. */
export class SpendCapConflictError extends Error {
  readonly status = 409;
  /** `undefined`: another save created it at the same moment, so its value is not known here. */
  constructor(readonly current: number | null | undefined) {
    super(
      current === undefined
        ? 'This cap changed since the page loaded.'
        : `This cap changed since the page loaded: it is now ${
            current === null ? 'unset' : `$${current.toFixed(2)}`
          }.`
    );
  }
}

/** The change could not be recorded, so it was not made. */
export class SpendCapUnavailableError extends Error {
  readonly status = 503;
  constructor(readonly dbStatus: Exclude<ModeratorDbStatus, 'ok'>) {
    super(`${spendCapUnavailableMessage(dbStatus)} No cap was changed.`);
  }
}

/**
 * The one write path for caps. The history row is written first and in the same transaction, so a change
 * that cannot be recorded does not happen. `usd: null` removes the row; `expect` is the cap as the
 * caller last read it (null: no row), and anything that moved since is refused.
 */
export async function changeSpendCap(input: {
  scope: SpendCapScope;
  subject: string;
  usd: number | null;
  expect: number | null;
  actorId: number;
  reason: string | null;
}): Promise<{ changed: boolean }> {
  try {
    return await db()
      .transaction()
      .execute(async (trx) => {
        const row = await trx
          .selectFrom('assistant_spend_cap')
          .select('usd_per_day')
          .where('scope', '=', input.scope)
          .where('subject', '=', input.subject)
          .forUpdate()
          .executeTakeFirst();
        const before = row ? Number(row.usd_per_day) : null;
        if (before !== input.expect) throw new SpendCapConflictError(before);
        if (before === input.usd) return { changed: false };

        await trx
          .insertInto('assistant_spend_cap_change')
          .values({
            actor_id: input.actorId,
            scope: input.scope,
            subject: input.subject,
            usd_before: before,
            usd_after: input.usd,
            reason: input.reason,
          })
          .executeTakeFirstOrThrow();

        const written =
          input.usd === null
            ? await trx
                .deleteFrom('assistant_spend_cap')
                .where('scope', '=', input.scope)
                .where('subject', '=', input.subject)
                .returning('subject')
                .executeTakeFirst()
            : before === null
            ? // No row to lock: a concurrent first save of the same cap fails this on the key.
              await trx
                .insertInto('assistant_spend_cap')
                .values({
                  scope: input.scope,
                  subject: input.subject,
                  usd_per_day: input.usd,
                  updated_by: input.actorId,
                })
                .returning('subject')
                .executeTakeFirst()
            : await trx
                .updateTable('assistant_spend_cap')
                .set({ usd_per_day: input.usd, updated_by: input.actorId, updated_at: new Date() })
                .where('scope', '=', input.scope)
                .where('subject', '=', input.subject)
                .returning('subject')
                .executeTakeFirst();
        if (!written) throw new Error('The cap write touched no row.');
        return { changed: true };
      });
  } catch (e) {
    if (e instanceof SpendCapConflictError) throw e;
    if ((e as { code?: unknown } | null)?.code === '23505')
      throw new SpendCapConflictError(undefined);
    console.error('[assistant] spend cap change failed, nothing was written', e);
    throw new SpendCapUnavailableError(moderatorDbStatus(e));
  }
}

export type SpendCapChange = {
  id: string;
  at: Date;
  actorId: number;
  scope: SpendCapScope;
  subject: string;
  before: number | null;
  after: number | null;
  reason: string | null;
};

export async function listSpendCapChanges(limit: number): Promise<SpendCapChange[]> {
  const rows = await db()
    .selectFrom('assistant_spend_cap_change')
    .select([
      'id',
      'at',
      'actor_id as actorId',
      'scope',
      'subject',
      'usd_before',
      'usd_after',
      'reason',
    ])
    .orderBy('id', 'desc')
    .limit(limit)
    .execute();
  return rows.map(({ usd_before, usd_after, ...r }) => ({
    ...r,
    id: String(r.id),
    before: usd_before === null ? null : Number(usd_before),
    after: usd_after === null ? null : Number(usd_after),
  }));
}
