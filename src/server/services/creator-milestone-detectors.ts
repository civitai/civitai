import type { MilestoneRegistryEntry } from '~/server/services/creator-milestone-registry';
import { creatorMilestoneRegistry } from '~/server/services/creator-milestone-registry';

type ActivityEntry = Exclude<MilestoneRegistryEntry, { detector: 'scoreSnapshot' }>;

/**
 * One set-based query per group of keys that share a detector, params, launch date and silence. It
 * selects "userId", "milestoneKey" and "achievedAt" (NULL when the moment is unknown) for every key
 * a user has reached but does not hold. `keys` and `users` are SQL placeholders; `users` narrows the
 * scan to those user ids, and NULL means everyone.
 */
export type MilestoneDetectorGroup = {
  id: string;
  keys: string[];
  launchedAt: Date;
  silent: boolean;
  /** Whether "achievedAt" is the real moment. Without it, a crossing cannot be dated. */
  timed: boolean;
  sql: (placeholders: { keys: string; users: string }) => string;
};

const notHeld = (user: string) => `NOT EXISTS (
    SELECT 1 FROM "UserCreatorMilestone" held
    WHERE held."userId" = ${user} AND held."milestoneKey" = m.key
  )`;

// What the profile counts (userModelCountCache, userArticleCountCache), so a badge never claims more
// published work than the creator's own profile shows. publishedAt is required to date the Nth item.
const publishedSources = {
  model: `SELECT x."userId", x."publishedAt", x.id FROM "Model" x
    WHERE x.status = 'Published' AND x.availability != 'Private'
      AND (x.mode IS NULL OR x.mode != 'Archived')
      AND x."deletedAt" IS NULL AND x."publishedAt" IS NOT NULL`,
  article: `SELECT x."userId", x."publishedAt", x.id FROM "Article" x
    WHERE x.status = 'Published' AND x.availability != 'Private'
      AND x."publishedAt" IS NOT NULL AND x."publishedAt" <= now()`,
} as const;

function detectorSql(entry: ActivityEntry): MilestoneDetectorGroup['sql'] {
  switch (entry.detector) {
    // The Nth item still published is dated by its own publishedAt.
    case 'publishedCount':
      return ({ keys, users }) => `
        SELECT r."userId", m.key AS "milestoneKey", r."publishedAt" AS "achievedAt"
        FROM (
          SELECT s."userId", s."publishedAt",
            row_number() OVER (PARTITION BY s."userId" ORDER BY s."publishedAt", s.id) AS n
          FROM (${publishedSources[entry.params.entity]}) s
          WHERE (${users}::int[] IS NULL OR s."userId" = ANY(${users}::int[]))
        ) r
        JOIN "CreatorMilestone" m ON m.key = ANY(${keys}::text[]) AND m.threshold = r.n
        WHERE ${notHeld('r."userId"')}`;
    case 'modelDownloads':
      return ({ keys, users }) => `
        SELECT d."userId", m.key AS "milestoneKey", NULL::timestamp AS "achievedAt"
        FROM (
          SELECT mm."userId", max(mm."downloadCount") AS top
          FROM "ModelMetric" mm
          WHERE mm.status = 'Published' AND mm.availability <> 'Private'
            AND (${users}::int[] IS NULL OR mm."userId" = ANY(${users}::int[]))
          GROUP BY mm."userId"
        ) d
        JOIN "CreatorMilestone" m ON m.key = ANY(${keys}::text[]) AND d.top >= m.threshold
        WHERE ${notHeld('d."userId"')}`;
    case 'userMetric':
      return ({ keys, users }) => `
        SELECT um."userId", m.key AS "milestoneKey", NULL::timestamp AS "achievedAt"
        FROM "UserMetric" um
        JOIN "CreatorMilestone" m
          ON m.key = ANY(${keys}::text[]) AND um."${entry.params.metric}" >= m.threshold
        WHERE um.timeframe = 'AllTime'
          AND (${users}::int[] IS NULL OR um."userId" = ANY(${users}::int[]))
          AND ${notHeld('um."userId"')}`;
  }
}

/** The registry's activity keys, grouped so each group is one query. Score tiers run in their own job. */
export function activityDetectorGroups(
  registry: Record<string, MilestoneRegistryEntry> = creatorMilestoneRegistry
): MilestoneDetectorGroup[] {
  const groups = new Map<string, MilestoneDetectorGroup>();
  for (const [key, entry] of Object.entries(registry)) {
    if (entry.detector === 'scoreSnapshot') continue;
    const id = [
      entry.detector,
      ...Object.values(entry.params),
      entry.launchedAt.toISOString(),
      entry.silent ? 'silent' : 'announced',
    ].join(':');
    const group = groups.get(id);
    if (group) group.keys.push(key);
    else
      groups.set(id, {
        id,
        keys: [key],
        launchedAt: entry.launchedAt,
        silent: !!entry.silent,
        timed: entry.detector === 'publishedCount',
        sql: detectorSql(entry),
      });
  }
  return [...groups.values()];
}
