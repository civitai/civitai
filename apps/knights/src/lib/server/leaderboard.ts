import { sql, type Kysely, type SqlBool } from 'kysely';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { KNIGHTS_STAGE_RANKS } from '@civitai/shared/new-order';
import { getLevelProgression } from '@civitai/shared/new-order-levels';
import { RANK_BADGE_IDS } from './progression/badges';
import { calculateFervor, fervorSince } from './progression/fervor';

export const LEADERBOARD_SIZE = 100;

export type LeaderboardEntry = {
  position: number;
  userId: number;
  username: string;
  /** A Civitai image key or a full URL, as on the session user. */
  image: string | null;
  rankType: string;
  level: number;
  fervor: number;
};

/** Every ranked player, best first. What the daily cache holds; positions are the index plus one. */
export type Board = {
  rows: Omit<LeaderboardEntry, 'position'>[];
  /** Rank to the image key of its badge cosmetic. A rank without one is absent. */
  badges: Record<string, string>;
};

/**
 * The board, computed from vote history alone (the shared `NewOrderPlayer.fervor` column is the original game's):
 * Knights and above, fervor from the votes cast in the window above 0, banned and deleted accounts left out, highest
 * first and the lower user id first on a tie. One grouped read of the window's votes.
 */
export async function queryBoard(db: Kysely<DB>, now: Date): Promise<Board> {
  const grouped = await db
    .selectFrom('KnightsVote as v')
    .innerJoin('NewOrderPlayer as p', 'p.userId', 'v.playerId')
    .innerJoin('User as u', 'u.id', 'p.userId')
    .leftJoin('Image as pic', 'pic.id', 'u.profilePictureId')
    .select([
      'p.userId',
      sql<string>`coalesce(u."username", 'Knight')`.as('username'),
      // The profile picture when it is rated PG or PG-13 (shown unblurred site-wide), else the legacy `User.image`.
      sql<
        string | null
      >`coalesce(case when pic."nsfwLevel" in (1, 2) then pic.url end, u.image)`.as('image'),
      'p.rankType',
      'p.exp',
      sql<string>`count(*)`.as('graded'),
      sql<string>`count(*) filter (where v.verdict = 'correct')`.as('correct'),
    ])
    .where('v.createdAt', '>=', utc(fervorSince(now)))
    .where('v.settledAt', 'is not', null)
    .where('v.verdict', 'in', ['correct', 'failed'])
    .where(sql<SqlBool>`v."createdAt" >= p."startAt"`)
    .where('p.rankType', 'in', [...KNIGHTS_STAGE_RANKS])
    .where('u.bannedAt', 'is', null)
    .where('u.deletedAt', 'is', null)
    .groupBy([
      'p.userId',
      'u.username',
      'u.image',
      'pic.url',
      'pic.nsfwLevel',
      'p.rankType',
      'p.exp',
    ])
    .execute();

  const rows = grouped
    .map(({ graded, correct, exp, ...player }) => ({
      ...player,
      level: getLevelProgression(exp).level,
      fervor: calculateFervor({ correct: Number(correct), graded: Number(graded) }),
    }))
    .filter((row) => row.fervor > 0)
    .sort((a, b) => b.fervor - a.fervor || a.userId - b.userId);

  const cosmetics = await db
    .selectFrom('Cosmetic')
    .select(['id', 'data'])
    .where('id', 'in', Object.values(RANK_BADGE_IDS))
    .where('source', '=', 'Trophy')
    .execute();
  const badges: Record<string, string> = {};
  for (const [rank, id] of Object.entries(RANK_BADGE_IDS)) {
    const url = (cosmetics.find((c) => c.id === id)?.data as { url?: unknown } | null)?.url;
    if (typeof url === 'string' && url) badges[rank] = url;
  }
  return { rows, badges };
}

export type Behind = { place: number; gap: number };

/** How far the row at `index` is behind the place above it (0 on a tie), or null for first place. */
export function standingGap(rows: { fervor: number }[], index: number): Behind | null {
  return index > 0 ? { place: index, gap: rows[index - 1].fervor - rows[index].fervor } : null;
}

/** The top of the board, plus the viewer's own row, position and gap to the place above, inside the list or not. */
export function viewBoard(
  board: Board,
  viewerId: number | null,
  { size = LEADERBOARD_SIZE }: { size?: number } = {}
): {
  entries: LeaderboardEntry[];
  self: (LeaderboardEntry & { behind: Behind | null }) | null;
  badges: Board['badges'];
} {
  const at = (index: number): LeaderboardEntry => ({ ...board.rows[index], position: index + 1 });
  const entries = board.rows.slice(0, size).map((_, index) => at(index));
  const own = viewerId === null ? -1 : board.rows.findIndex((row) => row.userId === viewerId);
  return {
    entries,
    self: own === -1 ? null : { ...at(own), behind: standingGap(board.rows, own) },
    badges: board.badges,
  };
}
