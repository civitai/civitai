import { sql } from '@civitai/db/kysely';
import { getBrowsingLevelLabel } from '@civitai/shared';
import { dbRead } from './db';
import { getClickhouse } from './clickhouse';
import { softly } from './user-signals.service';
import { getActiveStrikes, getCounts } from './user-lookup.service';
import { strikeCountsByUserIds } from './moderation-memory.service';
import { getAbuseFindingsForUser } from './abuse-detection.service';
import {
  getLinkedAccounts,
  getReactionBreadth,
  type LinkedAccounts,
  type ReactionBreadth,
} from './ip-links.service';
import { isInstantVerify, isInt4Id } from './users.service';

// One account, summarised for a report decision: who it is, what it posts, what has been said and
// done about it before, who it shares addresses with, and how wide its audience is.
//
// Each section degrades on its own to `null` — "could not be read", which is NOT an empty section.
// A ClickHouse blip must not blank the Postgres half, and a missing section must not read as a clean
// account.

export type DossierAccount = {
  username: string | null;
  createdAt: Date;
  ageDays: number;
  /** See `isInstantVerify`. */
  instantVerify: boolean | null;
  bannedAt: Date | null;
  banReason: string | null;
  deletedAt: Date | null;
  muted: boolean;
  muteExpiresAt: Date | null;
};

export type ImageMix = {
  /** Images read for the mix: the newest `IMAGE_SAMPLE`, so for a larger account it is a sample. */
  sampled: number;
  total: number;
  byLevel: { level: string; count: number }[];
  blocked: number;
  tosFlagged: number;
  /** All-time removal events from ClickHouse; the Postgres rows of removed images are gone. Null = unread. */
  removedTos: number | null;
  deletedByOwner: number | null;
};

export type ReportSummary = {
  /** Human-filed reports against the ACCOUNT, by status. Automated (scanner) reports counted apart. */
  byStatus: Record<string, number>;
  automated: number;
  /** actioned / (actioned + unactioned), human reports only; null when none were ruled. */
  actionedRate: number | null;
};

export type Enforcement = {
  strikesAllTime: number;
  activeStrikes: number;
  activePoints: number;
  /** Lifetime mute and ban events from the account's activity log. */
  mutes: number;
  bans: number;
};

export type AbuseSummary = {
  count: number;
  truncated: boolean;
  latest: {
    id: number;
    runId: number;
    reason: string;
    confidence: number;
    verdict: string | null;
    createdAt: Date;
  }[];
};

export type Dossier = {
  userId: number;
  account: DossierAccount | null;
  content: { label: string; count: number }[] | null;
  images: ImageMix | null;
  reports: ReportSummary | null;
  enforcement: Enforcement | null;
  abuse: AbuseSummary | null;
  linked: LinkedAccounts | null;
  breadth: ReactionBreadth | null;
};

/**
 * The image mix reads only the newest rows on the `(userId, id)` index. Big accounts are the slice this
 * panel exists for, and reading every row of one on each report open is a heap fetch per image.
 */
const IMAGE_SAMPLE = 10_000;

export async function getDossier(
  userId: number,
  { linkedLimit = 25, reactionDays = 180, breadthDays = 90 } = {}
): Promise<Dossier | null> {
  if (!isInt4Id(userId)) return null;
  const [account, content, images, reports, enforcement, abuse, linked, breadth] =
    await Promise.all([
      softly('dossier.account', () => getAccount(userId), null),
      softly(
        'dossier.content',
        async () => (await getCounts(userId)).map(({ label, count }) => ({ label, count })),
        null
      ),
      softly('dossier.images', () => getImageMix(userId), null),
      softly('dossier.reports', () => getReportSummary(userId), null),
      softly('dossier.enforcement', () => getEnforcement(userId), null),
      softly('dossier.abuse', () => getAbuseSummary(userId), null),
      softly(
        'dossier.linked',
        () => getLinkedAccounts(userId, { days: reactionDays, limit: linkedLimit }),
        null
      ),
      softly('dossier.breadth', () => getReactionBreadth(userId, breadthDays), null),
    ]);
  return { userId, account, content, images, reports, enforcement, abuse, linked, breadth };
}

async function getAccount(userId: number): Promise<DossierAccount | null> {
  const row = await dbRead
    .selectFrom('User')
    .select([
      'username',
      'createdAt',
      'emailVerified',
      'bannedAt',
      'deletedAt',
      'muted',
      'muteExpiresAt',
      sql<string | null>`meta #>> '{banDetails,reasonCode}'`.as('banReason'),
    ])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!row) return null;
  const created = new Date(row.createdAt);
  return {
    username: row.username,
    createdAt: created,
    ageDays: Math.floor((Date.now() - created.getTime()) / 86_400_000),
    instantVerify: isInstantVerify(created, row.emailVerified),
    bannedAt: row.bannedAt,
    banReason: row.banReason,
    deletedAt: row.deletedAt,
    muted: !!row.muted,
    muteExpiresAt: row.muteExpiresAt,
  };
}

async function getImageMix(userId: number): Promise<ImageMix> {
  const newest = dbRead
    .selectFrom('Image')
    .select(['nsfwLevel', 'ingestion', 'tosViolation'])
    .where('userId', '=', userId)
    .orderBy('id', 'desc')
    .limit(IMAGE_SAMPLE)
    .as('i');

  const [levels, total, removed] = await Promise.all([
    dbRead
      .selectFrom(newest)
      .select((eb) => [
        'i.nsfwLevel',
        eb.fn.countAll<string>().as('count'),
        sql<string>`count(*) FILTER (WHERE i.ingestion = 'Blocked')`.as('blocked'),
        sql<string>`count(*) FILTER (WHERE i."tosViolation")`.as('tos'),
      ])
      .groupBy('i.nsfwLevel')
      .execute(),
    dbRead
      .selectFrom('Image')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('userId', '=', userId)
      .executeTakeFirst(),
    softly(
      'dossier.removedImages',
      async () => {
        const rows = await getClickhouse().$query<{ tos: string; deleted: string }>(`
          SELECT countIf(type = 'DeleteTOS') AS tos, countIf(type = 'Delete') AS deleted
          FROM default.images
          PREWHERE ownerId = ${userId}
        `);
        return { tos: Number(rows[0]?.tos ?? 0), deleted: Number(rows[0]?.deleted ?? 0) };
      },
      null
    ),
  ]);

  return {
    sampled: levels.reduce((n, r) => n + Number(r.count), 0),
    total: Number(total?.count ?? 0),
    byLevel: levels
      .map((r) => ({
        level: r.nsfwLevel ? getBrowsingLevelLabel(r.nsfwLevel) : 'Unrated',
        count: Number(r.count),
        raw: r.nsfwLevel,
      }))
      .sort((a, b) => a.raw - b.raw)
      .map(({ level, count }) => ({ level, count })),
    blocked: levels.reduce((n, r) => n + Number(r.blocked), 0),
    tosFlagged: levels.reduce((n, r) => n + Number(r.tos), 0),
    removedTos: removed?.tos ?? null,
    deletedByOwner: removed?.deleted ?? null,
  };
}

async function getReportSummary(userId: number): Promise<ReportSummary> {
  const rows = await dbRead
    .selectFrom('UserReport as ur')
    .innerJoin('Report as r', 'r.id', 'ur.reportId')
    .select((eb) => [
      sql<string>`r.status::text`.as('status'),
      sql<boolean>`r.reason = 'Automated'`.as('automated'),
      eb.fn.countAll<string>().as('count'),
    ])
    .where('ur.userId', '=', userId)
    .groupBy(['r.status', sql`r.reason = 'Automated'`])
    .execute();

  const byStatus: Record<string, number> = {};
  let automated = 0;
  for (const row of rows) {
    if (row.automated) automated += Number(row.count);
    else byStatus[row.status] = (byStatus[row.status] ?? 0) + Number(row.count);
  }
  const ruled = (byStatus.Actioned ?? 0) + (byStatus.Unactioned ?? 0);
  return {
    byStatus,
    automated,
    actionedRate: ruled ? (byStatus.Actioned ?? 0) / ruled : null,
  };
}

async function getEnforcement(userId: number): Promise<Enforcement> {
  const [allTime, active, events] = await Promise.all([
    strikeCountsByUserIds([userId]),
    getActiveStrikes(userId),
    getClickhouse().$query<{ mutes: string; bans: string }>(`
      SELECT countIf(type = 'Muted') AS mutes, countIf(type = 'Banned') AS bans
      FROM default.userActivities
      WHERE targetUserId = ${userId}
    `),
  ]);
  return {
    strikesAllTime: allTime.get(userId) ?? 0,
    activeStrikes: active.count,
    activePoints: active.points,
    mutes: Number(events[0]?.mutes ?? 0),
    bans: Number(events[0]?.bans ?? 0),
  };
}

async function getAbuseSummary(userId: number): Promise<AbuseSummary> {
  const { findings, truncated } = await getAbuseFindingsForUser(userId, 20);
  return {
    count: findings.length,
    truncated,
    latest: findings.slice(0, 5).map((f) => ({
      id: f.id,
      runId: f.runId,
      reason: f.reason,
      confidence: f.confidence,
      verdict: f.verdict,
      createdAt: f.createdAt,
    })),
  };
}
