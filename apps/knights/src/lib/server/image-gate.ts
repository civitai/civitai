import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
  type Expression,
  type ExpressionBuilder,
  type SqlBool,
} from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import {
  noOpenImageReport,
  SERVABLE_IMAGE_CONTENT_MARKER,
  servableImage as servableImageFromTables,
  servableImageContent as servableImageContentFromTables,
} from '@civitai/db/knights';
import { gateExclusions } from './skill-check/exclusions';

type Joined = DB & { img: DB['Image']; p: DB['Post'] };
type Builder = ExpressionBuilder<Joined, 'img' | 'p'>;

/**
 * The columns of "KnightsImageGate", one row per image on a post. The Knights role reads that view and none of the tables
 * behind it (CSAM reports, evidence holds, scan labels, reports, models), so each column is one combined answer and none
 * says why an image is out. Every column but `sweepServable` implies `servable`.
 */
export const IMAGE_GATE_COLUMNS = [
  'servable',
  'sweepServable',
  'skillCheckEligible',
  'skillCheckLasting',
] as const;
export type ImageGateColumn = (typeof IMAGE_GATE_COLUMNS)[number];

/**
 * What each column answers, read from the tables themselves. "KnightsImageGate" is this, compiled
 * (`imageGateViewSql`); the main app and the moderator app keep reading the tables directly.
 */
export const imageGateColumns: Record<ImageGateColumn, (eb: Builder) => Expression<SqlBool>> = {
  servable: servableImageFromTables,
  sweepServable: servableImageContentFromTables,
  skillCheckEligible: (eb) =>
    eb.and([servableImageFromTables(eb), ...gateExclusions(false).map((clause) => clause(eb))]),
  skillCheckLasting: (eb) =>
    eb.and([servableImageFromTables(eb), ...gateExclusions(true).map((clause) => clause(eb))]),
};

const compiler = new Kysely<DB>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

function literal(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
  throw new Error(`No SQL literal for ${String(value)}`);
}

/** The SELECT behind "KnightsImageGate", its parameters written in. A NULL answer reads as false. */
export function imageGateViewSql(): string {
  const { sql: text, parameters } = compiler
    .selectFrom('Image as img')
    .innerJoin('Post as p', 'p.id', 'img.postId')
    .select((eb) => [
      'img.id as imageId',
      ...IMAGE_GATE_COLUMNS.map((column) =>
        sql<boolean>`COALESCE(${imageGateColumns[column](eb)}, false)`.as(column)
      ),
    ])
    .compile();
  return text.replace(/\$(\d+)/g, (_, n: string) => literal(parameters[Number(n) - 1]));
}

/** `column` of "KnightsImageGate" for `img`. Carries the JIT marker: the view still runs the CSAM subplans. */
export const imageGate = (column: ImageGateColumn) =>
  sql<SqlBool>`${sql.raw(SERVABLE_IMAGE_CONTENT_MARKER)} EXISTS (
    SELECT 1 FROM "KnightsImageGate" g WHERE g."imageId" = img.id AND g.${sql.raw(`"${column}"`)}
  )`;

/** `servableImage`, through the gate. Expects `Image as img` joined to `Post as p`. */
export const servableImage = (_eb: Builder) => imageGate('servable');

/** `servableImageContent`, through the gate. */
export const servableImageContent = (_eb: Builder) => imageGate('sweepServable');

/** `servableImageForSweeps`, through the gate: the content half and a post published by now. */
export const servableImageForSweeps = (eb: Builder) =>
  eb.and([
    imageGate('sweepServable'),
    eb('p.publishedAt', 'is not', null),
    eb('p.publishedAt', '<', sql<Date>`(now() AT TIME ZONE 'utc')`),
  ]);

/** `modReviewEligibleImage`, through the gate: the content half and no open report on the image. */
export const modReviewEligibleImage = (_eb: Builder) =>
  sql<SqlBool>`(${imageGate('sweepServable')} AND ${noOpenImageReport})`;
