import { raiseNsfwLevelText } from '@civitai/shared/rated-entity-sql';
import { NsfwLevel } from '~/server/common/enums';

/**
 * Storyline visibility as SQL text, for callers that build raw strings (the notification
 * queries) as well as the service's `Prisma.sql` forms, so the two cannot drift. Aliases are
 * the caller's; the defaults are the feed query's.
 */

/**
 * `getStorylineRootHiddenReason` is null: chapter 1 `rc`, its post `rp` and that post's author
 * `ru`. Change it with that function.
 */
export const storylineRootVisibleText = ({ rc = 'rc', rp = 'rp', ru = 'ru' } = {}) =>
  `(${rp}.id IS NOT NULL AND ${rc}."removedAt" IS NULL
  AND ${rp}."tosViolation" = false AND ${ru}."bannedAt" IS NULL AND ${ru}."deletedAt" IS NULL
  AND ${rp}."nsfwLevel" NOT IN (0, ${NsfwLevel.Blocked}) AND ${rp}."publishedAt" < now())`;

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
