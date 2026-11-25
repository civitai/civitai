import { NsfwLevel } from '~/server/common/enums';

/**
 * Which collections the semantic search may return, over "Collection" `c` and its owner "User"
 * `u`. Only accepted items make a collection non-empty. Item media is not checked here: hydration
 * serves the collection at its level-job nsfwLevel with a servable cover. The event-engine's
 * COLLECTION_ELIGIBLE_SQL is its copy, held to it by collection-eligibility.parity.test.ts.
 */
export const collectionSemanticEligibleText = ({ c = 'c', u = 'u' } = {}) =>
  `(${c}.read = 'Public' AND ${c}.availability NOT IN ('Unsearchable', 'Private')
  AND ${c}."userId" <> -1 AND ${c}."nsfwLevel" <> 0 AND (${c}."nsfwLevel" & ${NsfwLevel.Blocked}) = 0
  AND ${u}."bannedAt" IS NULL AND ${u}."deletedAt" IS NULL
  AND EXISTS (SELECT 1 FROM "CollectionItem" ci
    WHERE ci."collectionId" = ${c}.id AND ci.status = 'ACCEPTED'))`;
