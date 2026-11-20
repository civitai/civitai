import { sql, type ExpressionBuilder, type Expression, type SqlBool } from 'kysely';
import { servableImage } from '@civitai/db/knights';
import type { DB } from '@civitai/db-schema/kysely';

type Joined = DB & { img: DB['Image']; p: DB['Post'] };
type Builder = ExpressionBuilder<Joined, 'img' | 'p'>;

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
  {
    name: 'evidence-hold-image',
    clause: (eb) =>
      none(
        eb,
        eb
          .selectFrom('EvidenceHoldImage as ehi')
          .select(sql<number>`1`.as('one'))
          .whereRef('ehi.imageId', '=', 'img.id')
      ),
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
          .where('rep.status', 'in', ['Pending', 'Processing'])
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
