import { sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import {
  modReviewContent as modReviewContentFromTables,
  noOpenImagePull,
  noOpenImageReport,
  SERVABLE_IMAGE_CONTENT_MARKER,
  servableImage as servableImageFromTables,
  servableImageContent as servableImageContentFromTables,
} from '@civitai/db/knights';
import { inlineSql, offlineDb } from './offline-sql';
import { gateExclusions } from './skill-check/exclusions';

type Joined = DB & { img: DB['Image']; p: DB['Post'] };
type Builder = ExpressionBuilder<Joined, 'img' | 'p'>;

/**
 * The columns of "KnightsImageGate", one row per image on a post: image eligibility for the Knights role, each column
 * one combined answer, none saying why an image is out. The open-report check on a single image still reads ImageReport
 * and Report directly. Every column but `sweepServable` and `modReviewContent` implies `servable`; `modReviewContent`
 * implies `sweepServable`. A new column goes last: CREATE OR REPLACE VIEW only appends.
 */
export const IMAGE_GATE_COLUMNS = [
  'servable',
  'sweepServable',
  'skillCheckEligible',
  'skillCheckLasting',
  'modReviewContent',
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
  modReviewContent: modReviewContentFromTables,
};

/** The SELECT behind "KnightsImageGate", its parameters written in. A NULL answer reads as false. */
export function imageGateViewSql(): string {
  return inlineSql(
    offlineDb()
      .selectFrom('Image as img')
      .innerJoin('Post as p', 'p.id', 'img.postId')
      .select((eb) => [
        'img.id as imageId',
        ...IMAGE_GATE_COLUMNS.map((column) =>
          sql<boolean>`COALESCE(${imageGateColumns[column](eb)}, false)`.as(column)
        ),
      ])
      .compile()
  );
}

/**
 * `column` of "KnightsImageGate" for `img`. Carries the JIT marker: the view still runs the CSAM subplans.
 * OFFSET 0 keeps the EXISTS a subplan run per outer image (Image and Post primary-key probes). Without it Postgres may
 * plan a semi join that scans all of Image and Post on every call; `image-gate.pglite.test.ts` pins the subplan.
 */
export const imageGate = (column: ImageGateColumn) =>
  sql<SqlBool>`${sql.raw(SERVABLE_IMAGE_CONTENT_MARKER)} EXISTS (
    SELECT 1 FROM "KnightsImageGate" g WHERE g."imageId" = img.id AND g.${sql.raw(
      `"${column}"`
    )} OFFSET 0
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
  sql<SqlBool>`(${imageGate('modReviewContent')} AND ${noOpenImageReport})`;

/**
 * `servableImage` for a yes/no question or an Acolyte pair: the gate, and no open pull of the image (`noOpenImagePull`).
 * Only those two read the pull; the rating feed does not, and the sweeps read `servableImageForSweeps` on purpose, so a
 * pull hides questions until a moderator decides rather than closing them (the stale sweep still closes one that ages out).
 */
export const yesNoServableImage = (eb: Builder) => eb.and([imageGate('servable'), noOpenImagePull]);
