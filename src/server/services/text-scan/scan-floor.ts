import { Prisma } from '@prisma/client';
import {
  articleModerationFloorText,
  collectionTextFloorBucketText,
  ratedEntityContentNsfwLevelText,
  ratedEntityDerivedNsfwLevelText,
  type DerivedNsfwEntityType,
} from '@civitai/shared/rated-entity-sql';

export function articleModerationFloorSql(idColumn: string) {
  return Prisma.raw(articleModerationFloorText(idColumn));
}

export function collectionTextFloorBucketSql(alias: string, bucket: number) {
  return Prisma.raw(collectionTextFloorBucketText(alias, bucket));
}

export function ratedEntityDerivedNsfwLevelSql(entityType: DerivedNsfwEntityType, alias: string) {
  return Prisma.raw(ratedEntityDerivedNsfwLevelText(entityType, alias));
}

export function ratedEntityContentNsfwLevelSql(entityType: DerivedNsfwEntityType, alias: string) {
  return Prisma.raw(ratedEntityContentNsfwLevelText(entityType, alias));
}
