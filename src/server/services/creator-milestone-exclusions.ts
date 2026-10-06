import { constants } from '~/server/common/constants';

export const SYSTEM_USER_ID = constants.system.user.id;

/**
 * SQL predicate on a "User" row (aliased `alias`) that can receive a NEW creator milestone. It gates
 * grants only: badges are permanent, so nothing may use it to revoke one already held.
 */
export function milestoneGrantableUserSql(alias: string) {
  return `${alias}.id <> ${SYSTEM_USER_ID} AND ${alias}."deletedAt" IS NULL AND ${alias}."bannedAt" IS NULL`;
}
