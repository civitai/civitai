import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { memberOrRedirect } from './membership';
import { getPlayerStatus, type PlayerStatus } from './player-status';
import { getStanding, type Standing } from './standing';

/**
 * Reads made once per request and shared by everything that serves it. Keep them to reads nothing in the request changes
 * first: an action that writes reads `getPlayerStatus` itself, after its write.
 */

/** The signed-in user's ban and mute: the hooks read it to turn a banned account away, and every load and action reuses it. */
export function requestStanding(db: Kysely<DB>, locals: App.Locals): Promise<Standing> {
  locals.standing ??= getStanding(db, locals.user.id);
  return locals.standing;
}

/** The signed-in player's status, shared by the root layout (header) and the page load, which run side by side. */
export function requestPlayerStatus(
  db: Kysely<DB>,
  locals: App.Locals
): Promise<PlayerStatus | null> {
  locals.playerStatus ??= getPlayerStatus(db, locals.user.id);
  return locals.playerStatus;
}

/** `requireMember` for a load: the shared status, or a redirect to the home page, where a user joins. */
export async function requireRequestMember(
  db: Kysely<DB>,
  locals: App.Locals
): Promise<PlayerStatus> {
  return memberOrRedirect(await requestPlayerStatus(db, locals));
}
