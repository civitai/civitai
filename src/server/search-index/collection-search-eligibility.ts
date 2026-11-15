import { Prisma } from '@prisma/client';
import { CollectionReadConfiguration } from '~/shared/utils/prisma/enums';

/** Which collections the collections search index holds, as conditions on `c` ("Collection"). */
export const COLLECTION_SEARCH_ELIGIBLE = [
  Prisma.sql`c."userId" != -1`,
  Prisma.sql`c.read = ${CollectionReadConfiguration.Public}::"CollectionReadConfiguration"`,
  // Don't index empty collections:
  Prisma.sql`EXISTS (SELECT 1 FROM "CollectionItem" ci WHERE ci."collectionId" = c.id)`,
  Prisma.sql`c."availability" != 'Unsearchable'::"Availability"`,
];
