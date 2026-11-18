import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
  type CompiledQuery,
} from 'kysely';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { REFERENCE_POOL, REFERENCE_SOURCE, REFERENCE_STATUS } from '@civitai/db/knights';
import { MODERATOR_QUEUE_RATING_REASON } from './harvest.service';

/** A harvested hidden check stays only once this many players answered it and most of them gave its answer. */
export const KEEP_MIN_PLAYERS = 5;

/** Over half of a check's distinct players gave its answer. Expects `KnightsReferenceImage as k` and `KnightsVote as v`, grouped by check. */
export const majorityAgrees = sql<boolean>`2 * count(DISTINCT "v"."playerId") FILTER (WHERE "v"."answer" = "k"."answer") > count(DISTINCT "v"."playerId")`;

type Executor = Kysely<DB>;
const LIVE = [REFERENCE_STATUS.active, REFERENCE_STATUS.pending];

/** Harvested hidden checks whose players' answers agree with the ruling; a hidden check votes under -referenceId. */
function agreed(db: Executor, excludeImageIds: number[]) {
  return db
    .selectFrom('KnightsReferenceImage as k')
    .innerJoin('KnightsVote as v', (join) => join.on(sql<boolean>`"v"."itemId" = -"k"."id"`))
    .innerJoin('Image as img', 'img.id', 'k.imageId')
    .select('k.id')
    .where('k.pool', '=', REFERENCE_POOL.hiddenCheck)
    .where('k.source', '=', REFERENCE_SOURCE.harvested)
    .where(
      sql<boolean>`"img"."metadata"->>'nsfwLevelReason' IS DISTINCT FROM ${MODERATOR_QUEUE_RATING_REASON}`
    )
    .$if(excludeImageIds.length > 0, (qb) => qb.where('k.imageId', 'not in', excludeImageIds))
    .groupBy(['k.id', 'k.answer'])
    .having(sql<boolean>`count(DISTINCT "v"."playerId") >= ${KEEP_MIN_PLAYERS}`)
    .having(majorityAgrees);
}

export type RebuildInput = { now: Date; excludeImageIds: number[] };

/** The ids a run would retire: every live harvested hidden check outside the agreed set. Reads only. */
export function retirableIdsQuery(
  db: Executor,
  { excludeImageIds }: Pick<RebuildInput, 'excludeImageIds'>
) {
  return db
    .selectFrom('KnightsReferenceImage')
    .select('id')
    .where('pool', '=', REFERENCE_POOL.hiddenCheck)
    .where('source', '=', REFERENCE_SOURCE.harvested)
    .where('status', 'in', LIVE)
    .where('id', 'not in', agreed(db, excludeImageIds))
    .orderBy('id');
}

/**
 * Retires exactly `ids`, and only those still live, harvested, hidden and outside the agreed set, so answers that
 * arrive after the plan can only shrink what it touches. Status only; never deletes.
 */
export function retireIdsQuery(
  db: Executor,
  { now, excludeImageIds, ids }: RebuildInput & { ids: number[] }
) {
  return db
    .updateTable('KnightsReferenceImage')
    .set({ status: REFERENCE_STATUS.retired, updatedAt: utc(now) })
    .where('id', 'in', ids)
    .where('pool', '=', REFERENCE_POOL.hiddenCheck)
    .where('source', '=', REFERENCE_SOURCE.harvested)
    .where('status', 'in', LIVE)
    .where('id', 'not in', agreed(db, excludeImageIds));
}

/**
 * The retire for a run by hand, as one transaction that commits only if exactly `ids` were retired: the check divides
 * by zero on any other count, which aborts the transaction.
 */
export function checkedRetireSql(db: Executor, input: RebuildInput & { ids: number[] }): string {
  const update = inlineSql(retireIdsQuery(db, input).compile());
  const check = inlineSql(
    db
      .selectFrom('KnightsReferenceImage')
      .select(
        sql<number>`1 / (CASE WHEN count(*) = ${input.ids.length} THEN 1 ELSE 0 END)`.as(
          'retired_as_planned'
        )
      )
      .where('id', 'in', input.ids)
      .where('status', '=', REFERENCE_STATUS.retired)
      .where('updatedAt', '=', utc(input.now))
      .compile()
  );
  return ['BEGIN;', `${update};`, `${check};`, 'COMMIT;'].join('\n');
}

/** Live harvested hidden checks, and how many a run would keep and retire. Reads only. */
export async function planHiddenRebuild(
  db: Executor,
  input: Pick<RebuildInput, 'excludeImageIds'>
) {
  const live = await db
    .selectFrom('KnightsReferenceImage')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('pool', '=', REFERENCE_POOL.hiddenCheck)
    .where('source', '=', REFERENCE_SOURCE.harvested)
    .where('status', 'in', LIVE)
    .executeTakeFirstOrThrow();
  const ids = (await retirableIdsQuery(db, input).execute()).map((r) => r.id);
  return { live: Number(live.n), keep: Number(live.n) - ids.length, retire: ids.length, ids };
}

/** Plans and retires in one transaction; throws (and writes nothing) unless the update matches the plan exactly. */
export async function retireUnagreedHiddenChecks(db: Executor, input: RebuildInput) {
  return db.transaction().execute(async (trx) => {
    const { ids, ...before } = await planHiddenRebuild(trx, input);
    let retired = 0;
    if (ids.length > 0) {
      const result = await retireIdsQuery(trx, { ...input, ids }).executeTakeFirst();
      retired = Number(result.numUpdatedRows);
    }
    if (retired !== ids.length) {
      throw new Error(
        `Planned to retire ${ids.length} hidden checks, the update matched ${retired}.`
      );
    }
    const { ids: _left, ...after } = await planHiddenRebuild(trx, input);
    return { before, retired, after };
  });
}

/** A query builder that compiles Postgres SQL and never connects. */
export const offlineDb = () =>
  new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });

/** A compiled statement with its parameters written in, for a reviewed run by hand. */
export function inlineSql({ sql: text, parameters }: CompiledQuery): string {
  const literal = (value: unknown) => {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
    throw new Error(`Cannot inline a parameter of type ${typeof value}.`);
  };
  return text.replace(/\$(\d+)/g, (_, n: string) => {
    const index = Number(n) - 1;
    if (index >= parameters.length) throw new Error(`No parameter for $${n}.`);
    return literal(parameters[index]);
  });
}

export type RebuildArgs = {
  apply: boolean;
  printSql: boolean;
  excludeImageIds: number[];
  ids: number[] | null;
};

const idList = (flag: string, value: string | undefined) => {
  if (value === undefined || !/^\d+(,\d+)*$/.test(value)) {
    throw new Error(`${flag} takes a comma-separated list of ids with no spaces.`);
  }
  return value.split(',').map(Number);
};

/** Strict: an unknown or malformed argument is an error, so an id can never be dropped silently. */
export function parseRebuildArgs(argv: string[]): RebuildArgs {
  const args: RebuildArgs = { apply: false, printSql: false, excludeImageIds: [], ids: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--print-sql') args.printSql = true;
    else if (arg === '--exclude') args.excludeImageIds = idList(arg, argv[++i]);
    else if (arg === '--ids') args.ids = idList(arg, argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.apply && args.printSql) throw new Error('Pass --apply or --print-sql, not both.');
  if (args.ids && !args.printSql) throw new Error('--ids only goes with --print-sql.');
  return args;
}
