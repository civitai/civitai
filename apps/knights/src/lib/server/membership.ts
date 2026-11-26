import { fail, redirect } from '@sveltejs/kit';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { getPlayerStatus, type PlayerStatus } from './player-status';
import { hasConsented } from './seen';
import { seenStore } from './seen-runtime';

/** The player's status, or a redirect to the home page, where a user joins, if they have no player row. */
export async function requireMember(db: Kysely<DB>, userId: number): Promise<PlayerStatus> {
  return memberOrRedirect(await getPlayerStatus(db, userId));
}

/**
 * The player's rank alone, or the redirect to the home page. Cheaper than the full status for an action that only checks
 * the rank.
 */
export async function requireMemberRank(db: Kysely<DB>, userId: number): Promise<string> {
  const player = await db
    .selectFrom('NewOrderPlayer')
    .select('rankType')
    .where('userId', '=', userId)
    .executeTakeFirst();
  if (!player) redirect(303, '/home');
  return player.rankType;
}

/** A status read for a user, or the redirect to the home page when they have no player row. */
export function memberOrRedirect(status: PlayerStatus | null): PlayerStatus {
  if (!status) redirect(303, '/home');
  return status;
}

/**
 * Nothing that shows a judged image is served before the player accepts the mature content warning: v1 players arrive with a
 * player row but without that consent. False only when the store says so; an unreadable store lets them through.
 */
export async function consented(userId: number): Promise<boolean> {
  return (await hasConsented(seenStore, userId)) !== false;
}

/** Sends a player who has not accepted the warning to the home page, which asks for it. */
export async function requireConsent(userId: number): Promise<void> {
  if (!(await consented(userId))) redirect(303, '/home');
}

export const CONSENT_REQUIRED = 'Accept the mature content warning on the home page first.';
export const consentFailure = () => fail(403, { message: CONSENT_REQUIRED });
