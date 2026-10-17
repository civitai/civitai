import type { Kysely } from 'kysely';
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
 * - Tools are ordered by `Tool.priority` ascending with nulls last, as Prisma's `orderBy` compiled
 *   to. Ties keep no defined order on either path. Techniques are unordered, as in the source.
 * - The inner joins match Prisma's required relations: `toolId`/`techniqueId` are NOT NULL foreign
 *   keys with ON DELETE CASCADE, so a link row without its target cannot exist.
 */
export async function getImageGenerationFields(db: Kysely<DB>, id: number) {
  const row = await db
    .selectFrom('Image')
    .select((eb) => [
      'Image.hideMeta',
      'Image.generationProcess',
      'Image.meta',
      'Image.type',
      jsonArrayFrom(
        eb
          .selectFrom('ImageTool')
          .innerJoin('Tool', 'Tool.id', 'ImageTool.toolId')
          .select((eb) => [
            'ImageTool.notes',
            jsonBuildObject({
              id: eb.ref('Tool.id'),
              name: eb.ref('Tool.name'),
              icon: eb.ref('Tool.icon'),
              domain: eb.ref('Tool.domain'),
              priority: eb.ref('Tool.priority'),
            }).as('tool'),
          ])
          .whereRef('ImageTool.imageId', '=', 'Image.id')
          .orderBy('Tool.priority', 'asc')
      ).as('tools'),
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
    .executeTakeFirst();
  return row ?? null;
}
