import { sql, type ExpressionBuilder, type Kysely, type SqlBool, type Transaction } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { metrics, type SkillCheckReadSite } from '../metrics';
import { imageGate, servableImage } from '../image-gate';
import { minorSignalLevel, type ClauseOptions } from './exclusions';

export {
  LIFTING_EXCLUSIONS,
  minorSignalLevel,
  SKILL_CHECK_EXCLUSIONS,
  type ClauseOptions,
} from './exclusions';

type Joined = DB & { img: DB['Image']; p: DB['Post'] };
type Builder = ExpressionBuilder<Joined, 'img' | 'p'>;

/**
 * `servableImage` and every `SKILL_CHECK_EXCLUSIONS` clause, through "KnightsImageGate", plus the level half of
 * 'minor-signal', which takes a level. Expects `Image as img` joined to `Post as p`.
 */
export const skillCheckEligible = (eb: Builder, options?: ClauseOptions) =>
  eb.and([imageGate('skillCheckEligible'), minorSignalLevel(eb, options)]);

/**
 * Whether an answered image may be shown again (a notice, a recap): `servableImage`, and for a reference in the
 * mod-confirmed pool the safety exclusions too. `hidden`: the fallback when those cannot be read, which hides every
 * mod-confirmed image. Expects `Image as img`, `Post as p` and `KnightsReferenceImage as r` joined.
 */
export const answeredImageServable = (eb: Builder, skillChecks: 'checked' | 'hidden' = 'checked') =>
  eb.or([
    eb.and([sql<SqlBool>`"r"."pool" IS DISTINCT FROM 'skillCheck'`, servableImage(eb)]),
    skillChecks === 'checked'
      ? eb.and([sql<SqlBool>`"r"."pool" = 'skillCheck'`, skillCheckEligible(eb)])
      : eb.val(false),
  ]);

/** `servableImage` and the exclusions that never lift on their own: an image failing this can never be a check. */
export const skillCheckLasting = (eb: Builder, options?: ClauseOptions) =>
  eb.and([imageGate('skillCheckLasting'), minorSignalLevel(eb, options)]);

type Executor = Kysely<DB> | Transaction<DB>;
let savepoints = 0;

/**
 * Runs a read that applies the safety exclusions and fails closed: when it cannot be read (a missing table or view, a
 * timeout), it logs and returns `fallback`, which must keep the image out. Inside a transaction the read runs under a
 * savepoint, so the failure does not abort the caller's transaction.
 */
export async function failClosed<T>(
  db: Executor,
  site: SkillCheckReadSite,
  read: () => Promise<T>,
  fallback: T
): Promise<T> {
  const failed = (error: unknown) => {
    metrics.skillCheckReadUnreadable(site);
    console.error(
      `knights: a skill-check safety read (${site}) failed; keeping mod-confirmed checks out`,
      {
        error,
      }
    );
    return fallback;
  };
  if (!db.isTransaction) {
    try {
      return await read();
    } catch (error) {
      return failed(error);
    }
  }
  const name = sql.id(`skill_check_${++savepoints}`);
  await sql`SAVEPOINT ${name}`.execute(db);
  try {
    const result = await read();
    await sql`RELEASE SAVEPOINT ${name}`.execute(db);
    return result;
  } catch (error) {
    await sql`ROLLBACK TO SAVEPOINT ${name}`.execute(db);
    return failed(error);
  }
}
