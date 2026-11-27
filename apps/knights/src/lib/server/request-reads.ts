import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { memberOrRedirect } from './membership';
import { getPlayerStatus, type PlayerStatus } from './player-status';
import { getStanding, type Standing } from './standing';

// Shared per-request reads. An action that writes calls `getPlayerStatus` itself, after its write, not
// `requestPlayerStatus`.

/** The signed-in user's ban and mute, read once per request. */
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
