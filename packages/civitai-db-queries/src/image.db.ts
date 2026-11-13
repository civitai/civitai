import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { jsonArrayFrom, jsonBuildObject } from './infra/helpers';

/**
 * The columns and tool/technique links behind one image's generation data, in the exact shape the
 * Prisma `image.findUnique` it replaces returned: `null` for a missing image, and each link as
 * `{ notes, tool | technique: { … } }` so the caller's mapping is unchanged.
 *
 * Shape notes, each pinned by the parity suite against the Prisma original:
 * - The nested objects are built with `json_build_object`/`json_agg` (json, not jsonb), which keep
 *   the key order written here. jsonb would re-sort the keys, and the caller spreads these objects
 *   into its response, so key order reaches the serialized payload.
 * - Every nested field is int4/text, so nothing comes back as a JSON-stringified date or bigint.
 * - `type` and `generationProcess` are SCALAR enums (plain text over pg); no enum ARRAY is selected.
 * - Tools are ordered INSIDE the aggregate (`json_agg(… ORDER BY "Tool"."priority" ASC)`): Postgres
 *   does not promise to keep a sorted subquery's order through `json_agg`. The key is the one
 *   Prisma's `orderBy` compiled to, with no tie-breaker, so nulls sort last and ties keep no defined
 *   order on either path. Techniques are unordered, as in the source.
 * - The inner joins match Prisma's required relations ONLY because `toolId`/`techniqueId` are NOT
 *   NULL foreign keys with ON DELETE CASCADE (migrations `20240419174913_image_tools` and
 *   `20240508215105_image_techniques`), so a link row without its target cannot exist. Migrations are applied by
 *   hand, so that rests on those constraints being present in each database. Without them, Prisma
 *   would throw on an orphaned link and this query would drop it.
 */
type ToolLink = {
  notes: string | null;
  tool: {
    id: number;
    name: string;
    icon: string | null;
    domain: string | null;
    priority: number | null;
  };
};

export async function getImageGenerationFields(db: Kysely<DB>, id: number) {
  const row = await db
    .selectFrom('Image')
    .select((eb) => [
      'Image.hideMeta',
      'Image.generationProcess',
      'Image.meta',
      'Image.type',
      eb
        .selectFrom('ImageTool')
        .innerJoin('Tool', 'Tool.id', 'ImageTool.toolId')
        .select((eb) =>
          eb.fn
            .coalesce(
              eb.fn
                .jsonAgg(
                  jsonBuildObject({
                    notes: eb.ref('ImageTool.notes'),
                    tool: jsonBuildObject({
                      id: eb.ref('Tool.id'),
                      name: eb.ref('Tool.name'),
                      icon: eb.ref('Tool.icon'),
                      domain: eb.ref('Tool.domain'),
                      priority: eb.ref('Tool.priority'),
                    }),
                  })
                )
                .orderBy('Tool.priority', 'asc'),
              sql<[]>`'[]'`
            )
            .as('tools')
        )
        .whereRef('ImageTool.imageId', '=', 'Image.id')
        .$castTo<{ tools: ToolLink[] }>()
        .as('tools'),
      jsonArrayFrom(
        eb
          .selectFrom('ImageTechnique')
          .innerJoin('Technique', 'Technique.id', 'ImageTechnique.techniqueId')
          .select((eb) => [
            'ImageTechnique.notes',
            jsonBuildObject({
              id: eb.ref('Technique.id'),
              name: eb.ref('Technique.name'),
            }).as('technique'),
          ])
          .whereRef('ImageTechnique.imageId', '=', 'Image.id')
      ).as('techniques'),
    ])
    .where('Image.id', '=', id)
    // A scalar subquery is typed nullable, but an aggregate always yields one row and `coalesce`
    // turns an empty one into `[]`, so `tools` is never null. A type-only narrowing; no SQL changes.
    .$narrowType<{ tools: ToolLink[] }>()
    .executeTakeFirst();
  return row ?? null;
}

/**
 * One user's reactions across a set of images: the rows behind `getUserReactionsForImages`, in the
 * shape of the Prisma `imageReaction.findMany({ select: { imageId, reaction } })` it replaces.
 *
 * - `reaction` is the SCALAR `ReviewReactions` enum, which pg returns as plain text — no enum-array
 *   parser is involved.
 * - Deliberately NOT ordered, as the source had no `orderBy`. The caller groups by image and pushes
 *   in row order, so the order of reactions WITHIN one image follows the row order the planner
 *   returns on either path; neither path ever promised one.
 * - Empty `imageIds` short-circuits: Kysely would compile `IN ()`, a Postgres syntax error, where
 *   Prisma returned `[]`.
 */
export async function listImageReactionsMany(
  db: Kysely<DB>,
  input: { imageIds: number[]; userId: number }
) {
  if (!input.imageIds.length) return [];
  return db
    .selectFrom('ImageReaction')
    .select(['imageId', 'reaction'])
    .where('imageId', 'in', input.imageIds)
    .where('userId', '=', input.userId)
    .execute();
}
