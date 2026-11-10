import { Prisma } from '@prisma/client';
import { Availability, ModelStatus } from '~/shared/utils/prisma/enums';

/**
 * The ONE definition of "this model belongs in the models search index".
 *
 * Kept a leaf module — no meilisearch client, no db client — so a test can read it without
 * pulling the search-index runtime in, and so the places that decide index membership cannot
 * disagree:
 *
 *   1. `models.search-index.ts` — what gets WRITTEN: the bounds query and the delta scan's page
 *      query in `prepareModelsBatches`, and `pullModelsData`, which every batch is read through.
 *   2. `meilisearch/cleanup.ts` — what gets KEPT by the nightly reconciler; a document whose id
 *      this predicate no longer returns is deleted from the live index.
 *
 * `pullModelsData` reads through Prisma's query builder and the rest through raw SQL, so the
 * predicate has two renderings. Both are built from the one object below, and the SQL takes its
 * bind values from it, so a changed value cannot reach one rendering without the other.
 * The SQL is qualified with the `m` alias: callers alias `"Model"` as `m`.
 */
export const MODEL_SEARCH_INDEX_ELIGIBILITY = {
  status: ModelStatus.Published,
  availability: { not: Availability.Unsearchable },
} as const satisfies Prisma.ModelWhereInput;

export const modelSearchIndexEligibilitySql = () => Prisma.sql`
  m.status = ${MODEL_SEARCH_INDEX_ELIGIBILITY.status}::"ModelStatus"
  AND m.availability != ${MODEL_SEARCH_INDEX_ELIGIBILITY.availability.not}::"Availability"
`;
