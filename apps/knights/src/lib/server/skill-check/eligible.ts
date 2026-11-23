import {
  sql,
  type ExpressionBuilder,
  type Expression,
  type Kysely,
  type SqlBool,
  type Transaction,
} from 'kysely';
import { servableImage } from '@civitai/db/knights';
import { childBrowsingTagIds, NsfwLevel } from '@civitai/shared';
import type { DB } from '@civitai/db-schema/kysely';
import { csamSignalImageSql, heldImageSql, unreadableImageSql } from '@civitai/shared/held-media';
import { evidenceHeldUrlSql, reportListedUrlSql } from '@civitai/shared/held-url';

type Joined = DB & { img: DB['Image']; p: DB['Post'] };
type Builder = ExpressionBuilder<Joined, 'img' | 'p'>;

/** A report still waiting on a moderator. */
const OPEN_REPORT = ['Pending', 'Processing'];

const none = (eb: Builder, query: Expression<unknown>) => eb.not(eb.exists(query as never));

/**
 * What keeps an image out of the mod-confirmed skill-check pool on top of `servableImage`: anything that puts it under a
 * safety review or hold. One entry per reason, checked when a check is added and on every serve; replace the list, not
 * the callers, when the moderation lead's list changes. Expects `Image as img` joined to `Post as p`.
 */
export const SKILL_CHECK_EXCLUSIONS: {
  name: string;
  clause: (eb: Builder) => Expression<SqlBool>;
}[] = [
  { name: 'tos-violation', clause: (eb) => eb('img.tosViolation', '=', false) },
  // The shared legal-hold predicate: the image flagged for CSAM, or its owner's account held (named on a report, or under
  // an active evidence hold). Its legs compare nullable columns, so NULL reads as not held, as its own callers read it.
  {
    name: 'legal-hold',
    clause: () => sql<SqlBool>`NOT COALESCE(${sql.raw(heldImageSql('img'))}, false)`,
  },
  // The shared CSAM-signal predicate (a CSAM blocklist hash, a scan flag, a moderator vote or a CSAM hold on its label
  // item), NULL-safe like the hold.
  {
    name: 'csam-signal',
    clause: () => sql<SqlBool>`NOT COALESCE(${sql.raw(csamSignalImageSql('img'))}, false)`,
  },
  // Kept here though main dropped them from the shared predicate (that change was about moderator media access; these
  // images go to players): the legs of the former `suspectImageSql` that `csam-signal` and `servableImage` do not cover.
  // (a) A child tag on an image rated R or above, or unrated; (b) a scan flag or moderator vote marking a minor.
  {
    name: 'minor-signal',
    clause: (eb) =>
      eb.and([
        eb.or([
          eb.and([eb('img.nsfwLevel', '!=', 0), eb('img.nsfwLevel', '<', NsfwLevel.R)]),
          none(
            eb,
            eb
              .selectFrom('TagsOnImageDetails as st')
              .select(sql<number>`1`.as('one'))
              .whereRef('st.imageId', '=', 'img.id')
              .where('st.tagId', 'in', childBrowsingTagIds)
              .where('st.disabled', '=', false)
          ),
        ]),
        none(
          eb,
          eb
            .selectFrom('ScanLabelItem as si')
            .select(sql<number>`1`.as('one'))
            .whereRef('si.imageId', '=', 'img.id')
            .where((w) =>
              w.or([
                w.exists(
                  w
                    .selectFrom('ScanLabelFlag as sf')
                    .select(sql<number>`1`.as('one'))
                    .whereRef('sf.itemId', '=', 'si.id')
                    .where(sql<SqlBool>`sf.snapshot ->> 'minorDetected' = 'true'`)
                ),
                w.exists(
                  w
                    .selectFrom('ScanLabelVote as sv')
                    .select(sql<number>`1`.as('one'))
                    .whereRef('sv.itemId', '=', 'si.id')
                    .where((v) =>
                      v.or([v('sv.reason', '=', 'school-nsfw'), v('sv.reason', 'like', 'minor-%')])
                    )
                ),
              ])
            )
        ),
      ]),
  },
  // The shared unscanned predicate: an image whose scan has not landed.
  {
    name: 'unreadable-image',
    clause: () => sql<SqlBool>`NOT COALESCE(${sql.raw(unreadableImageSql('img'))}, false)`,
  },
  // The shared reported-image predicate: the image's bytes listed on a report.
  {
    name: 'reported-image',
    clause: () => sql<SqlBool>`NOT ${sql.raw(reportListedUrlSql('img."url"'))}`,
  },
  // The shared evidence-hold predicate, by the image's bytes.
  {
    name: 'evidence-hold-image',
    clause: () => sql<SqlBool>`NOT ${sql.raw(evidenceHeldUrlSql('img."url"'))}`,
  },
  {
    name: 'evidence-hold-post',
    clause: (eb) =>
      none(
        eb,
        eb
          .selectFrom('EvidenceHoldPost as ehp')
          .select(sql<number>`1`.as('one'))
          .whereRef('ehp.postId', '=', 'img.postId')
      ),
  },
  {
    name: 'open-report',
    clause: (eb) =>
      none(
        eb,
        eb
          .selectFrom('ImageReport as ir')
          .innerJoin('Report as rep', 'rep.id', 'ir.reportId')
          .select(sql<number>`1`.as('one'))
          .whereRef('ir.imageId', '=', 'img.id')
          .where('rep.status', 'in', OPEN_REPORT)
      ),
  },
  {
    name: 'open-post-report',
    clause: (eb) =>
      none(
        eb,
        eb
          .selectFrom('PostReport as pr')
          .innerJoin('Report as rep', 'rep.id', 'pr.reportId')
          .select(sql<number>`1`.as('one'))
          .whereRef('pr.postId', '=', 'img.postId')
          .where('rep.status', 'in', OPEN_REPORT)
      ),
  },
  {
    name: 'open-model-report',
    clause: (eb) =>
      none(
        eb,
        eb
          .selectFrom('ImageResourceNew as irn')
          .innerJoin('ModelVersion as mv', 'mv.id', 'irn.modelVersionId')
          .innerJoin('ModelReport as mr', 'mr.modelId', 'mv.modelId')
          .innerJoin('Report as rep', 'rep.id', 'mr.reportId')
          .select(sql<number>`1`.as('one'))
          .whereRef('irn.imageId', '=', 'img.id')
          .where('rep.status', 'in', OPEN_REPORT)
      ),
  },
  {
    name: 'open-user-report',
    clause: (eb) =>
      none(
        eb,
        eb
          .selectFrom('UserReport as ur')
          .innerJoin('Report as rep', 'rep.id', 'ur.reportId')
          .select(sql<number>`1`.as('one'))
          .whereRef('ur.userId', '=', 'img.userId')
          .where('rep.status', 'in', OPEN_REPORT)
      ),
  },
  {
    name: 'prompt-flag',
    clause: (eb) =>
      none(
        eb,
        eb
          .selectFrom('ImageFlag as f')
          .select(sql<number>`1`.as('one'))
          .whereRef('f.imageId', '=', 'img.id')
          .where((w) => w.or([w('f.promptNsfw', '=', true), w('f.resourcesNsfw', '=', true)]))
      ),
  },
  {
    name: 'pending-appeal',
    clause: (eb) =>
      none(
        eb,
        eb
          .selectFrom('Appeal as a')
          .select(sql<number>`1`.as('one'))
          .where('a.entityType', '=', 'Image')
          .whereRef('a.entityId', '=', 'img.id')
          .where('a.status', '=', 'Pending')
      ),
  },
  {
    name: 'text-scan-hold',
    clause: (eb) =>
      none(
        eb,
        eb
          .selectFrom('TextScanHold as t')
          .select(sql<number>`1`.as('one'))
          .where('t.status', '=', 'Pending')
          .where((w) =>
            w.or([
              w.and([w('t.entityType', '=', 'Image'), w('t.entityId', '=', w.ref('img.id'))]),
              w.and([w('t.entityType', '=', 'Post'), w('t.entityId', '=', w.ref('img.postId'))]),
            ])
          )
      ),
  },
  {
    // As `getStanding` reads a player: a banned, deleted or muted account.
    name: 'uploader-banned-or-muted',
    clause: (eb) =>
      none(
        eb,
        eb
          .selectFrom('User as u')
          .select(sql<number>`1`.as('one'))
          .whereRef('u.id', '=', 'img.userId')
          .where((w) =>
            w.or([
              w('u.bannedAt', 'is not', null),
              w('u.deletedAt', 'is not', null),
              w('u.muted', '=', true),
            ])
          )
      ),
  },
  {
    // A resource the image was made with is a model flagged as depicting a minor or a real person (`Model.minor`, `poi`).
    name: 'minor-or-poi-model',
    clause: (eb) =>
      none(
        eb,
        eb
          .selectFrom('ImageResourceNew as irn')
          .innerJoin('ModelVersion as mv', 'mv.id', 'irn.modelVersionId')
          .innerJoin('Model as m', 'm.id', 'mv.modelId')
          .select(sql<number>`1`.as('one'))
          .whereRef('irn.imageId', '=', 'img.id')
          .where((w) => w.or([w('m.minor', '=', true), w('m.poi', '=', true)]))
      ),
  },
  {
    name: 'open-inquisitor-item',
    clause: (eb) =>
      none(
        eb,
        eb
          .selectFrom('KnightsQueueItem as qi')
          .select(sql<number>`1`.as('one'))
          .whereRef('qi.imageId', '=', 'img.id')
          .where('qi.status', 'in', ['Inquisitor', 'Ruling'])
      ),
  },
];

/** `servableImage` and every `SKILL_CHECK_EXCLUSIONS` clause. Expects `Image as img` joined to `Post as p`. */
export const skillCheckEligible = (eb: Builder) =>
  eb.and([servableImage(eb), ...SKILL_CHECK_EXCLUSIONS.map(({ clause }) => clause(eb))]);

type Executor = Kysely<DB> | Transaction<DB>;
let savepoints = 0;

/**
 * Runs a read that applies the safety exclusions and fails closed: when it cannot be read (a missing table or view, a
 * timeout), it logs and returns `fallback`, which must keep the image out. Inside a transaction the read runs under a
 * savepoint, so the failure does not abort the caller's transaction.
 */
export async function failClosed<T>(
  db: Executor,
  label: string,
  read: () => Promise<T>,
  fallback: T
): Promise<T> {
  if (!db.isTransaction) {
    try {
      return await read();
    } catch (error) {
      console.error(`knights: ${label} could not be read; keeping mod-confirmed checks out`, {
        error,
      });
      return fallback;
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
    console.error(`knights: ${label} could not be read; keeping mod-confirmed checks out`, {
      error,
    });
    return fallback;
  }
}
