import { Prisma } from '@prisma/client';
import { dbRead } from '~/server/db/client';

/** Per matched hash, whether a model `userId` does not own already has a file with it. */
export async function findHashOwnership({ hashes, userId }: { hashes: string[]; userId: number }) {
  if (hashes.length === 0) return [];

  // `ModelFileHash.hash` is citext, so the ::citext[] cast is what makes this case-insensitive
  // AND indexable on modelFileHash_hash_cs. Do not "simplify" it to a plain IN over text or a
  // subquery: citext compared against an explicitly-typed text value degrades to a
  // case-sensitive text comparison, stored hashes are UPPERCASE, and the query then silently
  // returns nothing.
  // No poi/status/availability filter on purpose: a file already on another user's model must
  // block the bounty entry whatever that model's visibility.
  const rows = await dbRead.$queryRaw<{ userId: number; hash: string }[]>`
    SELECT DISTINCT m."userId",
           mfh."hash"
    FROM "ModelFileHash" mfh
           JOIN "ModelFile" mf ON mf."id" = mfh."fileId"
           JOIN "ModelVersion" mv ON mv."id" = mf."modelVersionId"
           JOIN "Model" m ON mv."modelId" = m.id
    WHERE mfh."hash" = ANY(ARRAY[${Prisma.join(hashes.map((h) => h.toLowerCase()))}]::citext[])
      AND m."deletedAt" IS NULL;
  `;

  const ownedByOther = new Map<string, boolean>();
  for (const row of rows) {
    ownedByOther.set(row.hash, (ownedByOther.get(row.hash) ?? false) || row.userId !== userId);
  }
  return [...ownedByOther].map(([hash, ownedByOther]) => ({ hash, ownedByOther }));
}
