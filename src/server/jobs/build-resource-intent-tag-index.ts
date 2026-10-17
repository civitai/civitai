import { env } from '~/env/server';
import { dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { coocSqlOf } from '~/server/services/resource-intent-cooc/store';
import { runTagIndexJob } from '~/server/services/resource-intent-tags/heartbeat';
import { s3TagIndexObjects } from '~/server/services/resource-intent-tags/objects';
import { runTagIndexBuild } from '~/server/services/resource-intent-tags/pipeline';
import { applyTagIndexRetention } from '~/server/services/resource-intent-tags/retention';
import { RESOURCE_INTENT_TAGS_SPEC_HASH } from '~/server/services/resource-intent-tags/spec';
import { createJob } from './job';

export const buildResourceIntentTagIndexJob = createJob(
  'build-resource-intent-tag-index',
  // Weekly, an hour after build-resource-intent-cooc ('0 5 * * 2').
  '0 6 * * 2',
  async () => {
    if (!(await isFlipt(FLIPT_FEATURE_FLAGS.RESOURCE_INTENT_TAG_INDEX_BUILD)))
      return { skipped: 'flag off' };
    // Retention runs here, after the build, rather than as a job of its own: snapshots change only
    // when this job runs, and its 24-hour grace (not the lock) keeps it off a fresh upload. It runs
    // whether or not the build succeeded, since a failed build is what leaves an unreferenced upload
    // behind (docs/resource-intent-primitive.md).
    return runTagIndexJob({
      build: async () => (await runTagIndexBuild({ dryRun: false }, { env })).summary,
      retention: async () => {
        try {
          return await applyTagIndexRetention(
            { sql: coocSqlOf(dbWrite), objects: s3TagIndexObjects() },
            { now: new Date(), specHash: RESOURCE_INTENT_TAGS_SPEC_HASH }
          );
        } catch (e) {
          logToAxiom({
            type: 'resource-intent-tag-index-retention-failed',
            error: e instanceof Error ? e.message : String(e),
          }).catch(() => undefined);
          throw e;
        }
      },
      kv: dbWrite,
      now: () => new Date(),
    });
  },
  // A concurrent second build would repeat every read. 90 min outlives a full build with retried
  // statements (docs/resource-intent-primitive.md, "Build job"); at a weekly cadence a long hold
  // blocks nothing. The build does not poll `checkIfCanceled`, so it finishes if the scheduler hangs
  // up.
  { lockExpiration: 90 * 60, keepLockOnDisconnect: true }
);
