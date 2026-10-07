import { chunk } from 'lodash-es';
import { NotificationCategory } from '~/server/common/enums';
import type { AugmentedPool } from '~/server/db/db-helpers';
import type {
  MilestoneCandidateRow,
  MilestoneDetectorGroup,
} from '~/server/services/creator-milestone-detectors';
import { joinMilestoneGrantableUserSql } from '~/server/services/creator-milestone-exclusions';
import type { MilestoneGrant } from '~/server/services/creator-milestone-grant.service';
import { grantMilestones } from '~/server/services/creator-milestone-grant.service';
import { createNotification } from '~/server/services/notification.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';

/**
 * The last run of a detector group that granted everything it found, whether grants were flag-gated
 * then, and the definitions it ran against.
 */
export type ActivityWatermark = { at: number; gated: boolean; definitions: string };

export type ActivityWatermarkStore = {
  get: (groupKey: string) => Promise<ActivityWatermark | null>;
  set: (groupKey: string, watermark: ActivityWatermark) => Promise<void>;
};

export type MilestoneDefinitionRow = { key: string; threshold: number | null };

export const watermarkKeyFor = (group: Pick<MilestoneDetectorGroup, 'watermarkId'>) =>
  `creator-milestones:watermark:${group.watermarkId}`;

/**
 * What a run granted against: its keys, thresholds and whether it announced. A watermark recorded
 * against anything else is no watermark, so the run is silent rather than announcing everyone the
 * change newly qualifies. It lives in the value, not the key, so reverting a change cannot revive an
 * old row.
 */
export const definitionsFingerprint = (
  definitions: MilestoneDefinitionRow[],
  silent: boolean,
  extra?: string
) =>
  `${silent ? 'silent' : 'announced'}|${definitions
    .map((d) => `${d.key}=${d.threshold}`)
    .sort()
    .join(',')}${extra ? `|${extra}` : ''}`;

/**
 * The earliest achievedAt that is announced, or null when nothing in this run is. A run can only
 * tell a fresh crossing from a backlog by comparing with the previous complete run, so without one
 * everything is silent. A timed group announces what was achieved since then. An untimed group
 * cannot date a crossing, so it announces only when neither run was flag-gated: while gated, users
 * outside the audience are never granted, and their backlog would look like tonight's crossings once
 * they join it.
 */
export function announceFromFor(
  group: Pick<MilestoneDetectorGroup, 'launchedAt' | 'silent' | 'timed'>,
  previous: ActivityWatermark | null,
  gated: boolean
): Date | null {
  if (group.silent || !previous) return null;
  const previousAt = new Date(previous.at);
  if (group.timed) return previousAt > group.launchedAt ? previousAt : group.launchedAt;
  if (previous.gated || gated || group.launchedAt > previousAt) return null;
  return previousAt;
}

// A NULL achievedAt is undated, so it is announced whenever anything is.
const silentSql = (announceFrom: string) => `CASE
    WHEN ${announceFrom}::timestamptz IS NULL THEN true
    WHEN c."achievedAt" IS NULL THEN false
    ELSE c."achievedAt" < (${announceFrom}::timestamptz AT TIME ZONE 'UTC')
  END`;

const candidateRowsSql = (rows: string, users: string) => `SELECT r."userId", r."milestoneKey",
    r."achievedAt" AT TIME ZONE 'UTC' AS "achievedAt"
  FROM jsonb_to_recordset(${rows}::jsonb)
    AS r("userId" int, "milestoneKey" text, "achievedAt" timestamptz)
  WHERE ${users}::int[] IS NULL OR r."userId" = ANY(${users}::int[])`;

/** What a group would grant to `users` (NULL for everyone), and the parameters that SQL reads. */
function groupCandidates(
  group: MilestoneDetectorGroup,
  rows: MilestoneCandidateRow[] | null,
  users: number[] | null
) {
  if ('sql' in group)
    return { sql: group.sql({ keys: '$1', users: '$2' }), params: [group.keys, users] };
  const wanted = users && new Set(users);
  const chosen = (rows ?? []).filter((row) => !wanted || wanted.has(row.userId));
  return { sql: candidateRowsSql('$1', '$2'), params: [JSON.stringify(chosen), users] };
}

export type ActivityGroupResult = {
  candidates: number;
  audience: number;
  granted: number;
  announced: number;
};

export async function runActivityGroup(
  group: MilestoneDetectorGroup,
  deps: {
    readPg: AugmentedPool;
    writePg: AugmentedPool;
    store: ActivityWatermarkStore;
    gated: boolean;
    audienceAmong: (userIds: number[]) => Promise<Set<number>>;
    notify?: (grants: MilestoneGrant[]) => Promise<void>;
    checkIfCanceled?: () => void;
    now?: Date;
    chunkSize?: number;
  }
): Promise<ActivityGroupResult> {
  const { readPg, writePg, store, gated, now = new Date(), chunkSize = 2000 } = deps;
  const notify = deps.notify ?? notifyMilestonesReached;

  // A run that matched no definition would still record a complete watermark, and the next run, with
  // the rows in place, would announce every qualifier as a crossing.
  const definitionQuery = await writePg.cancellableQuery<MilestoneDefinitionRow>(
    `SELECT key, threshold FROM "CreatorMilestone" WHERE key = ANY($1::text[])`,
    [group.keys]
  );
  const definitions = await definitionQuery.result();
  const missing = group.keys.filter((key) => !definitions.some((d) => d.key === key));
  if (missing.length) throw new Error(`No CreatorMilestone row for ${missing.join(', ')}`);

  const watermarkKey = watermarkKeyFor(group);
  const fingerprint = definitionsFingerprint(definitions, group.silent, group.fingerprint);
  const stored = await store.get(watermarkKey);
  const previous = stored?.definitions === fingerprint ? stored : null;
  const announceFrom = announceFromFor(group, previous, gated);

  let rows: MilestoneCandidateRow[] | null = null;
  let candidates: number[];
  if ('sql' in group) {
    const candidateQuery = await readPg.cancellableQuery<{ userId: number }>(
      `SELECT DISTINCT c."userId" FROM (${group.sql({ keys: '$1', users: '$2' })}) c`,
      [group.keys, null]
    );
    candidates = (await candidateQuery.result()).map((row) => row.userId);
  } else {
    rows = await group.candidates(readPg);
    candidates = [...new Set(rows.map((row) => row.userId))];
  }
  const users = gated ? [...(await deps.audienceAmong(candidates))] : candidates;

  let granted = 0;
  let announced = 0;
  for (const userChunk of chunk(
    users.sort((a, b) => a - b),
    chunkSize
  )) {
    deps.checkIfCanceled?.();
    const chunkCandidates = groupCandidates(group, rows, userChunk);
    const grants = await grantMilestones(writePg, {
      sql: `
        SELECT c."userId", c."milestoneKey", c."achievedAt", ${silentSql('$3')} AS silent
        FROM (${chunkCandidates.sql}) c`,
      params: [...chunkCandidates.params, announceFrom?.toISOString() ?? null],
    });
    granted += grants.length;
    let fresh = grants.filter((grant) => !grant.silent);
    // Ungated, everyone is granted, but only the flag audience is told: the page it links to is theirs.
    if (!gated && fresh.length) {
      const audience = await deps.audienceAmong([...new Set(fresh.map((g) => g.userId))]);
      fresh = fresh.filter((grant) => audience.has(grant.userId));
    }
    announced += fresh.length;
    // Sent per chunk: a re-run's ON CONFLICT never returns these grants again.
    await notify(fresh);
  }

  await store.set(watermarkKey, { at: now.getTime(), gated, definitions: fingerprint });
  return { candidates: candidates.length, audience: users.length, granted, announced };
}

export async function notifyMilestonesReached(grants: MilestoneGrant[]) {
  await limitConcurrency(
    grants.map(
      (grant) => () =>
        createNotification({
          type: 'creator-milestone-reached',
          category: NotificationCategory.Milestone,
          key: `creator-milestone-reached:${grant.userId}:${grant.milestoneKey}`,
          userId: grant.userId,
          details: { milestoneKey: grant.milestoneKey, name: grant.name },
        })
    ),
    4
  );
}

/** What the groups would grant if nobody were flag-gated, read only. This is the launch-day preview. */
export async function previewActivityGrants(pg: AugmentedPool, groups: MilestoneDetectorGroup[]) {
  const preview: { group: string; users: number; rows: number }[] = [];
  for (const group of groups) {
    const rows = 'sql' in group ? null : await group.candidates(pg);
    const candidates = groupCandidates(group, rows, null);
    const query = await pg.cancellableQuery<{ users: number; rows: number }>(
      `
      SELECT count(DISTINCT c."userId")::int AS users, count(*)::int AS rows
      FROM (${candidates.sql}) c
      ${joinMilestoneGrantableUserSql('u', 'c."userId"')}
      `,
      candidates.params
    );
    const [row] = await query.result();
    preview.push({ group: group.id, ...row });
  }
  return preview;
}
