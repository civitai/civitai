import { clickhouse } from '~/server/clickhouse/client';
import { dbWrite } from '~/server/db/client';
import { pgDbReadLong, pgDbWrite } from '~/server/db/pgDb';
import type { ActivityWatermarkStore } from '~/server/services/creator-milestone-activity.service';
import { runActivityGroup } from '~/server/services/creator-milestone-activity.service';
import type { MilestoneDetectorGroup } from '~/server/services/creator-milestone-detectors';
import {
  activityDetectorGroups,
  competeWinGroups,
  judgeVoteGroups,
} from '~/server/services/creator-milestone-detectors';
import type { QueryClickhouse } from '~/server/services/creator-milestone-stored';
import {
  loadStoredMilestoneGroups,
  StoredMilestoneSkip,
} from '~/server/services/creator-milestone-stored';
import {
  CREATOR_JOURNEY_GRANTS_REQUIRE_FLAG,
  creatorJourneyAudienceAmong,
} from '~/server/services/creator-journey-flag.service';
import { logToAxiom } from '~/server/logging/client';
import { createLogger } from '~/utils/logging';
import { createJob } from './job';

const log = createLogger('grant-creator-milestones');

/** One KeyValue row per detector group. Deleting a row makes that group's next run silent. */
export const keyValueWatermarkStore: ActivityWatermarkStore = {
  get: async (key) => {
    const row = await dbWrite.keyValue.findUnique({ where: { key } });
    const value = row?.value as
      | { at?: unknown; gated?: unknown; definitions?: unknown }
      | null
      | undefined;
    if (
      typeof value?.at !== 'number' ||
      typeof value.gated !== 'boolean' ||
      typeof value.definitions !== 'string'
    )
      return null;
    return { at: value.at, gated: value.gated, definitions: value.definitions };
  },
  set: async (key, watermark) => {
    await dbWrite.keyValue.upsert({
      where: { key },
      create: { key, value: watermark },
      update: { value: watermark },
    });
  },
};

/** Evaluates each user once per run: most candidates appear in several groups. */
export function memoizedAudience(evaluate: (userIds: number[]) => Promise<Set<number>>) {
  const known = new Map<number, boolean>();
  return async (userIds: number[]) => {
    const unknown = userIds.filter((id) => !known.has(id));
    if (unknown.length) {
      const inAudience = await evaluate(unknown);
      for (const id of unknown) known.set(id, inAudience.has(id));
    }
    return new Set(userIds.filter((id) => known.get(id)));
  };
}

export const queryClickhouse: QueryClickhouse = async (query, settings) => {
  if (!clickhouse) throw new Error('ClickHouse is not configured');
  const response = await clickhouse.query({
    query,
    format: 'JSONEachRow',
    clickhouse_settings: settings,
  });
  return response.json();
};

// Key, outcome and timing only: a stored query's text and parameters never leave the job.
function reportStored(details: {
  milestoneKey: string;
  outcome: 'ran' | 'skipped' | 'unreadable';
  ms?: number;
  reason?: string;
  code?: string;
}) {
  log('stored milestone', details);
  logToAxiom({ type: 'info', name: 'creator-milestone-stored', ...details });
}

const logSkip = (skip: StoredMilestoneSkip) =>
  reportStored({
    milestoneKey: skip.milestoneKey,
    outcome: 'skipped',
    reason: skip.reason,
    code: skip.code,
  });

/**
 * The milestones defined on their own rows. Unreadable definitions (the column not yet migrated, say)
 * leave the code registry's groups to run alone.
 */
async function storedGroups(): Promise<MilestoneDetectorGroup[]> {
  try {
    return await loadStoredMilestoneGroups(pgDbWrite, { onSkip: logSkip, queryClickhouse });
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    reportStored({
      milestoneKey: '*',
      outcome: 'unreadable',
      code: typeof code === 'string' ? code : undefined,
    });
    return [];
  }
}

// Activity milestones. Score tiers are granted inside update-user-score, the only place scores change.
export const grantCreatorMilestones = createJob(
  'grant-creator-milestones',
  '20 1 * * *',
  async (jobContext) => {
    const gated = CREATOR_JOURNEY_GRANTS_REQUIRE_FLAG;
    const results: Record<string, unknown> = {};
    const failures: string[] = [];
    const audienceAmong = memoizedAudience((userIds) =>
      creatorJourneyAudienceAmong(pgDbReadLong, userIds)
    );

    const stored = await storedGroups();
    // Judge votes and wins are also found row by row, so a group's shape cannot say it came from a row.
    const storedIds = new Set(stored.map((group) => group.id));
    const groups = [
      ...activityDetectorGroups(),
      ...judgeVoteGroups(queryClickhouse),
      ...competeWinGroups(queryClickhouse),
      ...stored,
    ];
    for (const group of groups) {
      jobContext.checkIfCanceled();
      const startedAt = Date.now();
      const storedKey = storedIds.has(group.id) ? group.keys[0] : null;
      try {
        results[group.id] = await runActivityGroup(group, {
          readPg: pgDbReadLong,
          writePg: pgDbWrite,
          store: keyValueWatermarkStore,
          gated,
          audienceAmong,
          checkIfCanceled: () => jobContext.checkIfCanceled(),
        });
        if (storedKey)
          reportStored({ milestoneKey: storedKey, outcome: 'ran', ms: Date.now() - startedAt });
      } catch (e) {
        // Its watermark stays put, so the next run picks up from the last complete one.
        if (e instanceof StoredMilestoneSkip) {
          reportStored({
            milestoneKey: e.milestoneKey,
            outcome: 'skipped',
            reason: e.reason,
            code: e.code,
            ms: Date.now() - startedAt,
          });
          results[group.id] = { skipped: e.reason };
          continue;
        }
        log('group failed', group.id, e);
        failures.push(group.id);
      }
    }

    if (failures.length)
      throw new Error(`grant-creator-milestones: ${failures.length} group(s) failed: ${failures}`);
    return results;
  },
  { lockExpiration: 60 * 60, queue: 'metrics' }
);
