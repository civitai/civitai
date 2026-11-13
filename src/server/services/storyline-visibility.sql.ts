import { raiseNsfwLevelText } from '@civitai/shared/rated-entity-sql';
import { NsfwLevel } from '~/server/common/enums';

/**
 * Storyline visibility as SQL text, for callers that build raw strings (the notification
 * queries) as well as the service's `Prisma.sql` forms, so the two cannot drift. Aliases are
 * the caller's; the defaults are the feed query's.
 */

/** `storylineRootVisibleText` with any publication time: a scheduled chapter 1 counts. */
const storylineRootReadyText = ({ rc = 'rc', rp = 'rp', ru = 'ru' } = {}) =>
  `(${rp}.id IS NOT NULL AND ${rc}."removedAt" IS NULL
  AND ${rp}."tosViolation" = false AND ${ru}."bannedAt" IS NULL AND ${ru}."deletedAt" IS NULL
  AND ${rp}."nsfwLevel" NOT IN (0, ${NsfwLevel.Blocked}) AND ${rp}."publishedAt" IS NOT NULL)`;

/**
 * `getStorylineRootHiddenReason` is null: chapter 1 `rc`, its post `rp` and that post's author
 * `ru`. Change it with that function.
 */
export const storylineRootVisibleText = ({ rc = 'rc', rp = 'rp', ru = 'ru' } = {}) =>
  `(${storylineRootReadyText({ rc, rp, ru })} AND ${rp}."publishedAt" < now())`;

/**
 * Which storylines the semantic search may return: the public feed's gates for a reader who is
 * neither owner, participant nor moderator, over storyline `st`, its owner `u`, chapter 1 `rc`
 * (LEFT JOINed at depth 0), its post `rp` and that post's author `ru`, with chapter 1's post
 * Public (its text is in the index). Publication time is left to the query (the payload's
 * rootPublishedAt), so a scheduled chapter 1 needs no event when it goes live. The event-engine's
 * STORYLINE_ELIGIBLE_SQL is its copy, held to it by storyline-eligibility.parity.test.ts.
 */
export const storylineSemanticEligibleText = ({
  st = 'st',
  u = 'u',
  rc = 'rc',
  rp = 'rp',
  ru = 'ru',
} = {}) =>
  `(${st}."tosViolation" = false AND ${u}."bannedAt" IS NULL AND ${u}."deletedAt" IS NULL
  AND ${storylineRootReadyText({ rc, rp, ru })} AND ${rp}.availability = 'Public')`;

/**
 * The level `isStorylineOutsideLevel` judges a storyline `st` by: chapter 1's post `rp` (the
 * ceiling when it is gone or unrated), raised to the title's rating.
 */
export const storyLevelText = ({ st = 'st', rp = 'rp' } = {}) =>
  `(SELECT ${raiseNsfwLevelText('lv.l', 'lv.f')}
  FROM (SELECT COALESCE(NULLIF(NULLIF(${rp}."nsfwLevel", 0), ${
    NsfwLevel.Blocked
  }), ${st}."maxNsfwLevel") AS l,
    COALESCE(${st}."moderatorNsfwLevel", ${st}."nsfwLevel") AS f) lv)`;
