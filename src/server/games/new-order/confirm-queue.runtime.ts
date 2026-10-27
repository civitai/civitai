import { dbWrite } from '~/server/db/client';
import {
  runConfirmSync,
  type AgreedItem,
  type ConfirmPools,
  type ConfirmStore,
  type PooledItem,
} from '~/server/games/new-order/confirm-queue';
import { poolCounters } from '~/server/games/new-order/utils';
import { logToAxiom } from '~/server/logging/client';
import { recordUnderSavepoint, type LabelStoreTx } from '~/server/services/label-store.service';
import { addImageToQueue, manageSanityChecks } from '~/server/services/games/new-order.service';
import { browsingLevels } from '~/shared/constants/browsingLevel.constants';
import { NewOrderRankType } from '~/shared/utils/prisma/enums';

export const CONFIRM_LABEL_FAMILY = 'knights_confirm';
export const CONFIRM_LABEL_QUESTION = 'knights_confirm.image.rating';

class LabelsNotRecorded extends Error {}

const BATCH = 200;
const ACOLYTE_PRIORITY = 1;

const isRatingLevel = (level: number) => (browsingLevels as readonly number[]).includes(level);

export async function enqueueConfirmItems(
  items: { imageId: number; level: number }[],
  modId: number,
  at = new Date()
) {
  const rows = items.filter((i) => isRatingLevel(i.level));
  if (!rows.length) return;
  try {
    await dbWrite.$executeRaw`
      INSERT INTO "KnightsConfirmItem" ("imageId", "firstLevel", "firstModId", "firstSetAt")
      SELECT t."imageId", t."firstLevel", ${modId}::int, ${at}::timestamptz
      FROM unnest(${rows.map((r) => r.imageId)}::int[], ${rows.map((r) => r.level)}::int[])
        AS t("imageId", "firstLevel")
      ON CONFLICT ("imageId") WHERE "status" = 'open' DO NOTHING
    `;
  } catch (error) {
    await logToAxiom({
      type: 'error',
      name: 'knights-confirm-enqueue',
      message: (error as Error).message,
      details: { modId, imageIds: rows.map((r) => r.imageId) },
    }).catch(() => null);
  }
}

async function recordJudgment(tx: LabelStoreTx, item: AgreedItem, which: 'first' | 'second') {
  const first = which === 'first';
  const [row] = await tx.$queryRaw<{ id: bigint | number | null }[]>`
    SELECT label_store.record_label(
      p_subject_type => 'image'::text,
      p_subject_id => ${String(item.imageId)}::text,
      p_content_hash => label_store.text_hash(${item.url}::text),
      p_family => ${CONFIRM_LABEL_FAMILY}::text,
      p_question => ${CONFIRM_LABEL_QUESTION}::text,
      p_value => ${String(item.firstLevel)}::text,
      p_labeller_kind => 'moderator',
      p_labeller_user_id => ${first ? item.firstModId : item.secondModId}::int,
      p_source_ref => ${`KnightsConfirm:${item.id}:${which}`}::text,
      p_labelled_at => ${first ? item.firstSetAt : item.secondAt}::timestamptz,
      p_snapshot => ${JSON.stringify({ v: 1, itemId: item.id, blind: !first })}::jsonb
    ) AS id
  `;
  return row?.id != null;
}

export const confirmStore: ConfirmStore = {
  async agreedUnpooled() {
    return dbWrite.$queryRaw<AgreedItem[]>`
      SELECT k.id, k."imageId", img.url, k."firstLevel", img."nsfwLevel" AS "imageLevel",
        k."firstModId", k."secondModId", k."firstSetAt", k."secondAt"
      FROM "KnightsConfirmItem" k
      JOIN "Image" img ON img.id = k."imageId"
      WHERE k.status = 'agreed' AND k."pooledAt" IS NULL AND k."expiredAt" IS NULL
      ORDER BY k."secondAt"
      LIMIT ${BATCH}
    `;
  },

  async markPooled(item, now) {
    try {
      return await dbWrite.$transaction(async (tx) => {
        const updated = await tx.$executeRaw`
          UPDATE "KnightsConfirmItem" SET "pooledAt" = ${now}::timestamptz
          WHERE id = ${item.id} AND "pooledAt" IS NULL
        `;
        if (!updated) return true;
        const recorded = await recordUnderSavepoint(
          tx,
          async () => {
            const first = await recordJudgment(tx, item, 'first');
            const second = await recordJudgment(tx, item, 'second');
            return first && second;
          },
          (error) =>
            void logToAxiom({
              type: 'error',
              name: 'knights-confirm-label',
              message: (error as Error).message,
              details: { itemId: item.id },
            }).catch(() => null)
        );
        // Rolls the pooledAt write back so the next run retries; refs make the retry idempotent.
        if (!recorded) throw new LabelsNotRecorded();
        return true;
      });
    } catch {
      return false;
    }
  },

  async markStale(ids, now) {
    await dbWrite.$executeRaw`
      UPDATE "KnightsConfirmItem" SET "expiredAt" = ${now}::timestamptz
      WHERE id = ANY(${ids}::int[]) AND "pooledAt" IS NULL
    `;
  },

  async pooledActive() {
    return dbWrite.$queryRaw<PooledItem[]>`
      SELECT id, "imageId", "secondAt" FROM "KnightsConfirmItem"
      WHERE status = 'agreed' AND "pooledAt" IS NOT NULL AND "expiredAt" IS NULL
    `;
  },

  async markExpired(ids, now) {
    await dbWrite.$executeRaw`
      UPDATE "KnightsConfirmItem" SET "expiredAt" = ${now}::timestamptz
      WHERE id = ANY(${ids}::int[])
    `;
  },
};

export const confirmPools: ConfirmPools = {
  async add(imageIds) {
    await addImageToQueue({
      imageIds,
      rankType: NewOrderRankType.Acolyte,
      priority: ACOLYTE_PRIORITY,
    });
    await manageSanityChecks({ add: imageIds });
  },
  async remove(imageIds) {
    const acolyte = poolCounters[NewOrderRankType.Acolyte];
    await Promise.all([...acolyte.a, ...acolyte.b].map((pool) => pool.reset({ id: imageIds })));
    await manageSanityChecks({ remove: imageIds });
  },
};

export const syncConfirmQueue = () => runConfirmSync({ store: confirmStore, pools: confirmPools });
