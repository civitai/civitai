import { sql, type ExpressionBuilder, type Expression, type SqlBool } from 'kysely';
import { childBrowsingTagIds, NsfwLevel } from '@civitai/shared';
import type { DB } from '@civitai/db-schema/kysely';
import { csamSignalImageSql, heldImageSql, unreadableImageSql } from '@civitai/shared/held-media';
import { reportListedUrlSql } from '@civitai/shared/held-url';

type Joined = DB & { img: DB['Image']; p: DB['Post'] };
type Builder = ExpressionBuilder<Joined, 'img' | 'p'>;

/** A report still waiting on a moderator. */
const OPEN_REPORT = ['Pending', 'Processing'] as const;

const none = (eb: Builder, query: Expression<unknown>) => eb.not(eb.exists(query as never));

/** What a clause may be asked about the image: `level`, the level it would have (default: the one it has). */
export type ClauseOptions = { level?: number };

/**
 * The level half of 'minor-signal': it passes when the level the image has, or would have (`level`), is rated and
 * under R, or when no child-browsing tag is on it. It takes a level and reads only the image and its tags, so it stays out of
 * "KnightsImageGate" and every caller ANDs it in.
 */
export const minorSignalLevel = (eb: Builder, options?: ClauseOptions) =>
  eb.or([
    options?.level !== undefined
      ? eb.val(options.level > 0 && options.level < NsfwLevel.R)
      : eb.and([eb('img.nsfwLevel', '!=', 0), eb('img.nsfwLevel', '<', NsfwLevel.R)]),
    none(
      eb,
      eb
        .selectFrom('TagsOnImageDetails as st')
        .select(sql<number>`1`.as('one'))
        .whereRef('st.imageId', '=', 'img.id')
        .where('st.tagId', 'in', childBrowsingTagIds)
        .where('st.disabled', '=', false)
    ),
  ]);

/** The scan half of 'minor-signal': no scan flag or moderator vote on its label item points at a minor. */
const minorSignalScan = (eb: Builder) =>
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
  );

/**
 * Safety exclusions on top of servableImage, one per reason; checked when a check is added and on every serve. Expects
 * Image as img joined to Post as p.
 */

export const SKILL_CHECK_EXCLUSIONS: {
  name: string;
  clause: (eb: Builder, options?: ClauseOptions) => Expression<SqlBool>;
}[] = [
  { name: 'tos-violation', clause: (eb) => eb('img.tosViolation', '=', false) },
  // NULL-safe: its legs compare nullable columns, so NULL reads as not held, as its own callers read it.
  {
    name: 'held-media',
    clause: () => sql<SqlBool>`NOT COALESCE(${sql.raw(heldImageSql('img'))}, false)`,
  },
  // The shared CSAM-signal predicate (a CSAM blocklist hash, a scan flag, a moderator vote or a CSAM hold on its label
  // item), NULL-safe like the hold.
  {
    name: 'csam-signal',
    clause: () => sql<SqlBool>`NOT COALESCE(${sql.raw(csamSignalImageSql('img'))}, false)`,
  },
  // The minor-signal legs (minorSignalLevel and minorSignalScan above).
  {
    name: 'minor-signal',
    clause: (eb, options) => eb.and([minorSignalLevel(eb, options), minorSignalScan(eb)]),
  },
  {
    name: 'unreadable-image',
    clause: () => sql<SqlBool>`NOT COALESCE(${sql.raw(unreadableImageSql('img'))}, false)`,
  },
  {
    name: 'reported-image',
    clause: () => sql<SqlBool>`NOT ${sql.raw(reportListedUrlSql('img."url"'))}`,
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

/**
 * The exclusions that lift on their own in time: a report or appeal still waiting, a scan hold, an image whose scan has
 * not landed, an Inquisitor ruling under way. Every other one (and failing `servableImage`) does not.
 */
export const LIFTING_EXCLUSIONS = new Set([
  'unreadable-image',
  'open-report',
  'open-post-report',
  'open-model-report',
  'open-user-report',
  'pending-appeal',
  'text-scan-hold',
  'open-inquisitor-item',
]);

/** The exclusions as "KnightsImageGate" carries them: 'minor-signal' without `minorSignalLevel`. */
export const gateExclusions = (lasting: boolean) =>
  SKILL_CHECK_EXCLUSIONS.filter(({ name }) => !lasting || !LIFTING_EXCLUSIONS.has(name)).map(
    ({ name, clause }) =>
      name === 'minor-signal' ? (eb: Builder) => minorSignalScan(eb) : (eb: Builder) => clause(eb)
  );
