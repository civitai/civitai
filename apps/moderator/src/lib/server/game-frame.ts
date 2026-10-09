import { env } from '$env/dynamic/private';

const TIMEOUT_MS = 10_000;

export type DelistOutcome =
  | { ok: true; affected: number }
  | { ok: false; status: number; message: string };

// Game Frame accepts `^[\p{L}\p{N}_.-]{1,64}$`; a legacy username outside it would be refused for good.
const MOD_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const modName = (moderator: { id: number; username: string | null }) =>
  moderator.username && MOD_NAME_RE.test(moderator.username)
    ? moderator.username
    : `mod-${moderator.id}`;

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
          'x-gf-mod-name': modName(input.moderator),
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
    ok?: unknown;
    state?: unknown;
    affected?: unknown;
    error?: unknown;
    message?: unknown;
  } | null;

  // A 2xx that is not Game Frame's own answer (a proxy or maintenance page) must not action the report.
  if (res.ok && body?.ok === true && body.state === 'delisted')
    return { ok: true, affected: Array.isArray(body.affected) ? body.affected.length : 0 };
  if (res.ok)
    return {
      ok: false,
      status: 502,
      message: 'Game Frame gave an unexpected answer. Nothing changed.',
    };
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

export function delistReason(game: { reason: string; violation: string | null }, reportId: number) {
  return `Reported: ${game.violation ?? game.reason}; report #${reportId}`;
}
