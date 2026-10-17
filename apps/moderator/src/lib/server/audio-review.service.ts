import { audioModerationResultSchema } from '@civitai/shared/audio-moderation';
import { dbWrite } from '$lib/server/db';

export type AudioReviewFilter = 'flagged' | 'all' | 'failed' | 'reviewed';

export async function getAudioReviews(filter: AudioReviewFilter, cursor?: number) {
  let query = dbWrite
    .selectFrom('AudioModerationScan as scan')
    .innerJoin('Image as image', 'image.id', 'scan.imageId')
    .select([
      'scan.id',
      'scan.imageId',
      'scan.sourceUrl',
      'scan.sourceHash',
      'scan.status',
      'scan.error',
      'scan.attempts',
      'scan.result',
      'scan.flagged',
      'scan.createdAt',
      'scan.completedAt',
      'scan.wouldBlock',
      'scan.reviewedAt',
      'scan.reviewerId',
      'scan.reviewNotes',
      'image.type',
    ])
    .whereRef('image.url', '=', 'scan.sourceUrl');
  if (filter === 'flagged')
    query = query.where('scan.flagged', '=', true).where('scan.reviewedAt', 'is', null);
  if (filter === 'reviewed') query = query.where('scan.reviewedAt', 'is not', null);
  if (filter === 'failed') query = query.where('scan.error', 'is not', null);
  if (cursor) query = query.where('scan.id', '<', cursor);
  const rows = await query.orderBy('scan.id', 'desc').limit(51).execute();
  return {
    rows: rows.slice(0, 50).map(({ result, ...row }) => {
      const parsed = audioModerationResultSchema.safeParse(result);
      return { ...row, result: parsed.success ? parsed.data : null };
    }),
    nextCursor: rows.length > 50 ? rows[49].id : null,
  };
}

export async function recordAudioReview(input: {
  id: number;
  sourceHash: string;
  wouldBlock: boolean;
  notes: string;
  reviewerId: number;
}) {
  const result = await dbWrite
    .updateTable('AudioModerationScan')
    .set({
      wouldBlock: input.wouldBlock,
      reviewNotes: input.notes || null,
      reviewerId: input.reviewerId,
      reviewedAt: new Date(),
    })
    .where('id', '=', input.id)
    .where('sourceHash', '=', input.sourceHash)
    .where('status', '=', 'Succeeded')
    .where('flagged', 'is not', null)
    .where('reviewedAt', 'is', null)
    .where(({ exists, selectFrom }) =>
      exists(
        selectFrom('Image')
          .select('id')
          .whereRef('Image.id', '=', 'AudioModerationScan.imageId')
          .whereRef('Image.url', '=', 'AudioModerationScan.sourceUrl')
      )
    )
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

export async function audioSampleBatch(from: Date, to: Date, cursor: number) {
  return dbWrite
    .selectFrom('AudioModerationScan')
    .selectAll()
    .where('createdAt', '>=', from)
    .where('createdAt', '<', to)
    .where('id', '>', cursor)
    .orderBy('id', 'asc')
    .limit(500)
    .execute();
}
