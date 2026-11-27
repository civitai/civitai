import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { kyselyOver } from '~/server/db/prisma-kysely';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

/**
 * A `$queryRaw` implementation that answers the deal-file use check (`assertNotDealFileImages`) as
 * "a delivery file's copy" only when that check was bound with `id`, so a site that checks a
 * different row than the one it attaches is seen. Every other raw query goes to `otherwise`, or
 * gets `[]`.
 */
export const dealCopyCheckFor = (
  id: number,
  otherwise?: (strings: TemplateStringsArray, ...values: unknown[]) => unknown
) =>
  (async (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.join('').includes('ServiceDealFile') &&
    values.some((value) => Array.isArray(value) && value.includes(id))
      ? [{ dealFileImage: true }]
      : otherwise?.(strings, ...values) ?? []) as never;

/**
 * A `deleteImages` over PGlite as the real one runs: the rows go and `onDeleted` runs with them in
 * one transaction, so a throw from either takes both back. `where` narrows the rows that go.
 */
export const deleteImagesIn =
  (db: PGlite, where = 'true') =>
  async (
    ids: number[],
    options?: { onDeleted?: (db: Kysely<DB>, deleted: { id: number }[]) => Promise<void> }
  ) =>
    db.transaction(async (tx) => {
      const { rows } = await tx.query<{ id: number }>(
        `DELETE FROM "Image" WHERE id = ANY($1::int[]) AND ${where} RETURNING id`,
        [ids]
      );
      const raw = pgliteRaw(tx as unknown as PGlite);
      if (rows.length && options?.onDeleted)
        await options.onDeleted(kyselyOver({ $queryRaw: raw.queryRaw } as never), rows);
      return rows;
    });
