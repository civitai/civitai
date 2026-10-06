import { constants } from '~/server/common/constants';

export const SYSTEM_USER_ID = constants.system.user.id;

/**
 * SQL predicate on a "User" row (aliased `alias`) that can receive a NEW creator milestone. It gates
 * grants only: badges are permanent, so nothing may use it to revoke one already held.
 */
export function milestoneGrantableUserSql(alias: string) {
  return `${alias}.id <> ${SYSTEM_USER_ID} AND ${alias}."deletedAt" IS NULL AND ${alias}."bannedAt" IS NULL`;
}

/** Joins "User" as `alias` on `userIdSql`, keeping only accounts that can receive a new milestone. */
export function joinMilestoneGrantableUserSql(alias: string, userIdSql: string) {
  const grantable = milestoneGrantableUserSql(alias);
  return `JOIN "User" ${alias} ON ${alias}.id = ${userIdSql} AND ${grantable}`;
}

/**
 * Score tier `milestone` (a "CreatorMilestone" alias) is owed to "User" `user`: the stored total
 * reaches it and the user does not hold it yet.
 */
export function owedScoreTierSql(user: string, milestone: string) {
  return `${milestone}.track = 'score' AND ${milestone}.threshold IS NOT NULL
    AND (${user}.meta->'scores'->>'total')::numeric >= ${milestone}.threshold
    AND NOT EXISTS (
      SELECT 1 FROM "UserCreatorMilestone" held
      WHERE held."userId" = ${user}.id AND held."milestoneKey" = ${milestone}.key
    )`;
}
