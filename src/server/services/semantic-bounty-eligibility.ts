import { NsfwLevel } from '~/server/common/enums';

/**
 * Which bounties the semantic search may return, over "Bounty" `b` and its owner "User" `u`.
 * Open, expired and awarded depend on the clock and are filtered per query. The event-engine's
 * BOUNTY_ELIGIBLE_SQL is its copy, held to it by bounty-eligibility.parity.test.ts.
 */
export const bountySemanticEligibleText = ({ b = 'b', u = 'u' } = {}) =>
  `(${b}."userId" IS NOT NULL AND ${b}."userId" <> -1
  AND ${b}.availability NOT IN ('Unsearchable', 'Private') AND NOT ${b}.poi
  AND ${b}."nsfwLevel" <> 0 AND (${b}."nsfwLevel" & ${NsfwLevel.Blocked}) = 0
  AND ${u}."bannedAt" IS NULL AND ${u}."deletedAt" IS NULL)`;
