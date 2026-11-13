import type { Prisma } from '@prisma/client';
import { Availability, CollectionReadConfiguration } from '~/shared/utils/prisma/enums';

// The set updateCollectionsNsfwLevels rates; anything else has no audience to protect.
export const VISIBLE_COLLECTION_WHERE = {
  availability: Availability.Public,
  read: { in: [CollectionReadConfiguration.Public, CollectionReadConfiguration.Unlisted] },
} satisfies Prisma.CollectionWhereInput;

export const isVisibleCollection = (c: { availability: string; read: string }) =>
  c.availability === VISIBLE_COLLECTION_WHERE.availability &&
  (VISIBLE_COLLECTION_WHERE.read.in as readonly string[]).includes(c.read);
