/**
 * The input schemas of the endpoints the Go feed service ports (apps/feed-go, DESIGN.md §5.1), as zod's
 * JSON-Schema projection of the schemas the routes parse: each schema's top-level keys and the
 * defaults it applies to an absent key.
 *
 *   - `getInfiniteImagesSchema`: `image.getImagesAsPostsInfinite` and `image.getInfinite`.
 *   - `getAllModelsSchema`: `model.getAll` (its router input, `getAllModelsInputSchema`).
 *   - `imagesEndpointSchema`: `GET /api/v1/images`.
 *   - `siteSearchParamsSchema`, `siteMultiSearchSchema` (and `siteMultiSearchQuerySchema`, one of its
 *     `queries`) and `siteFacetSearchSchema`: `POST /api/search/[...path]`.
 *
 * The Go parsers accept only the keys listed here, and fall back (`input-unknown-key`) on any other, so
 * a key the app adds to a schema is never silently dropped by a Go build that does not know it.
 *
 * Writes apps/feed-go/internal/inputschema/schemas.json:
 *
 *   pnpm exec tsx scripts/feed-go-input-schemas.ts
 *
 * `scripts/__tests__/feed-go-input-schemas.schema-drift.test.ts` fails when the committed file
 * differs from this output, so a schema change cannot land without regenerating it.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import { getInfiniteImagesSchema } from '~/server/schema/image.schema';
import { imagesEndpointSchema } from '~/server/schema/images-endpoint.schema';
import { getAllModelsInputSchema } from '~/server/schema/model.schema';
import {
  siteFacetSearchSchema,
  siteMultiSearchSchema,
  siteSearchParamsSchema,
} from '~/server/schema/site-search.schema';

export const FEED_GO_INPUT_SCHEMAS_PATH = join(
  __dirname,
  '..',
  'apps/feed-go/internal/inputschema/schemas.json'
);

type Projected = { properties?: Record<string, { default?: unknown }> };

function project(schema: z.ZodType) {
  // The INPUT side (what a request may carry), with any type JSON Schema cannot express (a transform, a
  // Date, a bigint) projected as `{}`: only the keys and the defaults are read.
  const projected = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Projected;
  const properties = projected.properties ?? {};
  const keys = Object.keys(properties).sort();
  const defaults: Record<string, unknown> = {};
  for (const key of keys) {
    const value = properties[key]?.default;
    if (value !== undefined) defaults[key] = value;
  }
  return { keys, defaults };
}

export function buildFeedGoInputSchemas() {
  return {
    getInfiniteImagesSchema: project(getInfiniteImagesSchema),
    getAllModelsSchema: project(getAllModelsInputSchema),
    imagesEndpointSchema: project(imagesEndpointSchema),
    siteSearchParamsSchema: project(siteSearchParamsSchema),
    siteMultiSearchSchema: project(siteMultiSearchSchema),
    siteMultiSearchQuerySchema: project(siteMultiSearchSchema.shape.queries.element),
    siteFacetSearchSchema: project(siteFacetSearchSchema),
  };
}

export function renderFeedGoInputSchemas() {
  return JSON.stringify(buildFeedGoInputSchemas(), null, 2) + '\n';
}

if (process.argv[1]?.endsWith('feed-go-input-schemas.ts')) {
  writeFileSync(FEED_GO_INPUT_SCHEMAS_PATH, renderFeedGoInputSchemas());
  console.log(`wrote ${FEED_GO_INPUT_SCHEMAS_PATH}`);
}
