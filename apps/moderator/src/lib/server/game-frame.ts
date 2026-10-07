import { env } from '$env/dynamic/private';
import { dbRead, dbWrite } from './db';

const TIMEOUT_MS = 10_000;

export type ReportedGame = { slug: string; reason: string; violation: string | null };

/** The game a report is about, read through its join row. Null for a report that is not a game's. */
export async function getReportedGame(reportId: number): Promise<ReportedGame | null> {
  // The primary, not the replica: the moderator is acting on a row they just opened.
  const row = await dbWrite
    .selectFrom('Report as r')
    .innerJoin('GameFrameGameReport as j', 'j.reportId', 'r.id')
    .innerJoin('GameFrameGame as g', 'g.id', 'j.gameFrameGameId')
    .select(['g.slug', 'r.reason', 'r.details'])
    .where('r.id', '=', reportId)
    .executeTakeFirst();
  if (!row) return null;
  const details = row.details as { violation?: unknown } | null;
  return {
    slug: row.slug,
    reason: row.reason,
    violation: typeof details?.violation === 'string' ? details.violation : null,
  };
}

export type GameMirror = { id: number; title: string; visibility: string; official: boolean };

/** What the mirror row says about each reported game, as of Game Frame's last push. */
export async function getGameMirrors(ids: number[]): Promise<GameMirror[]> {
  if (!ids.length) return [];
  return dbRead
    .selectFrom('GameFrameGame')
    .select(['id', 'title', 'visibility', 'official'])
    .where('id', 'in', ids)
    .execute();
}

export type DelistOutcome =
  | { ok: true; affected: number }
  | { ok: false; status: number; message: string };

/** HTTP header values must be printable ASCII; usernames need not be. */
function headerSafe(value: string) {
  return value.replace(/[^\x20-\x7e]/g, '?').slice(0, 64);
}

/**
 * Asks Game Frame to delist a game (and its forks). Game Frame accepts the service token only
 * together with the moderator headers, and writes that moderator to its own moderation log.
 */
export async function delistGame(
  input: {
    slug: string;
    reason: string;
    reportId: number;
    moderator: { id: number; username: string | null };
  },
  fetchImpl: typeof fetch = fetch
): Promise<DelistOutcome> {
  const base = env.GF_BASE_URL;
  const token = env.GF_MOD_SERVICE_TOKEN;
  if (!base || !token)
    return { ok: false, status: 503, message: 'Game Frame delisting is not configured here.' };

  let res: Response;
  try {
    res = await fetchImpl(
      new URL(`/api/mod/games/${encodeURIComponent(input.slug)}/delist`, base),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-gf-mod-id': String(input.moderator.id),
          'x-gf-mod-name': headerSafe(input.moderator.username || `mod-${input.moderator.id}`),
        },
        body: JSON.stringify({ reason: input.reason.slice(0, 500), reportId: input.reportId }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }
    );
  } catch (err) {
    // The class name only: a fetch error can carry the request, and the request carries the token.
    console.error('[game-frame] delist failed to send', (err as Error)?.name ?? 'Error');
    return { ok: false, status: 504, message: "Game Frame didn't answer. Retrying is safe." };
  }

  const body = (await res.json().catch(() => null)) as {
    affected?: unknown;
    error?: unknown;
    message?: unknown;
  } | null;

  if (res.ok)
    return { ok: true, affected: Array.isArray(body?.affected) ? body.affected.length : 0 };
  if (res.status === 403)
    return { ok: false, status: 502, message: 'Game Frame refused the delist (config).' };
  if (res.status === 404)
    return { ok: false, status: 404, message: 'Game Frame has no such game.' };
  const detail =
    typeof body?.message === 'string'
      ? body.message
      : typeof body?.error === 'string'
      ? body.error
      : `HTTP ${res.status}`;
  return { ok: false, status: 502, message: `Game Frame could not delist it: ${detail}` };
}

export function delistReason(game: ReportedGame, reportId: number) {
  return `Reported: ${game.violation ?? game.reason}; report #${reportId}`;
}
