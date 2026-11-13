import { raiseNsfwLevelText } from '@civitai/shared/rated-entity-sql';
import { NsfwLevel } from '~/server/common/enums';
import {
  semanticImageHeldText,
  semanticUserHeldText,
} from '~/server/services/semantic-held-content.sql';

/**
 * Storyline visibility as SQL text, for callers that build raw strings (the notification
 * queries) as well as the service's `Prisma.sql` forms, so the two cannot drift. Aliases are
 * the caller's; the defaults are the feed query's.
 */

/** Chapter 1 shown to readers, with `published` as the publication test on its post `rp`. */
const storylineRootText = ({ rc = 'rc', rp = 'rp', ru = 'ru' }, published: string) =>
  `(${rp}.id IS NOT NULL AND ${rc}."removedAt" IS NULL
  AND ${rp}."tosViolation" = false AND ${ru}."bannedAt" IS NULL AND ${ru}."deletedAt" IS NULL
  AND ${rp}."nsfwLevel" NOT IN (0, ${NsfwLevel.Blocked}) AND ${published})`;

/**
 * `getStorylineRootHiddenReason` is null: chapter 1 `rc`, its post `rp` and that post's author
 * `ru`. Change it with that function.
 */
export const storylineRootVisibleText = ({ rc = 'rc', rp = 'rp', ru = 'ru' } = {}) =>
  storylineRootText({ rc, rp, ru }, `${rp}."publishedAt" < now()`);

/**
 * Which storylines the semantic search may return: the public feed's gates for a reader who is
 * neither owner, participant nor moderator, over storyline `st`, its owner `u`, chapter 1 `rc`
 * (LEFT JOINed at depth 0), its post `rp` and that post's author `ru`, with chapter 1's post
 * Public (its text is in the index), and nothing held: neither the owner nor chapter 1's author,
 * nor any of chapter 1's images. Publication time is left to the query (the payload's
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
  AND ${storylineRootText({ rc, rp, ru }, `${rp}."publishedAt" IS NOT NULL`)}
  AND ${rp}.availability = 'Public'
  AND NOT ${semanticUserHeldText(`${st}."userId"`)} AND NOT ${semanticUserHeldText(
    `${rp}."userId"`
  )}
  AND NOT EXISTS (SELECT 1 FROM "Image" ri WHERE ri."postId" = ${rp}.id
    AND ${semanticImageHeldText('ri')}))`;

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
