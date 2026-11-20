import { dbKV } from '~/server/db/db-helpers';
import { kyselyWrite } from '~/server/db/kyselyDb';
import {
  runKnightsPublishSampling,
  type PublishSampleCursor,
} from '~/server/services/knights/sampling';
import { readKnightsSourcesConfig } from '~/server/services/knights/sources';
import { createJob } from './job';

const JOB_NAME = 'knights-publish-sampling';
/** `KeyValue` row holding the last post read, `{ publishedAt: epoch ms, postId }`. */
const CURSOR_KEY = `${JOB_NAME}:cursor`;

type StoredCursor = { publishedAt: number; postId: number };

const parseCursor = (value: unknown): PublishSampleCursor | null => {
  const stored = value as Partial<StoredCursor> | null | undefined;
  if (!stored || !Number.isFinite(stored.publishedAt) || !Number.isInteger(stored.postId))
    return null;
  return { publishedAt: new Date(stored.publishedAt as number), postId: stored.postId as number };
};

/**
 * Samples images into the Knights queue once their post goes live, whatever set `publishedAt` (an owner's publish, a
 * scheduled date arriving, a model, version or collection publish). Scan-time sampling only takes images already live.
 * The cursor is stored only after a run completes, and not at all when the sources switch could not be read, so a
 * failed or blind run is retried.
 */
export const knightsPublishSampling = createJob(JOB_NAME, '*/1 * * * *', async () => {
  // primary: a replica behind the window's end would let posts slip past the cursor.
  const result = await runKnightsPublishSampling(kyselyWrite, {
    now: new Date(),
    readConfig: readKnightsSourcesConfig,
    loadCursor: async () => parseCursor(await dbKV.get<StoredCursor>(CURSOR_KEY)),
    saveCursor: (cursor) =>
      dbKV.set<StoredCursor>(CURSOR_KEY, {
        publishedAt: cursor.publishedAt.getTime(),
        postId: cursor.postId,
      }),
  });
  if ('skipped' in result) return result;
  return {
    ...result,
    cursor: { publishedAt: result.cursor.publishedAt.toISOString(), postId: result.cursor.postId },
  };
});
