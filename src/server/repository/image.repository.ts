import { Expression, InferResult } from 'kysely';
import { jsonArrayFrom, jsonObjectFrom } from '~/server/kysely-db';
import { Repository } from '~/server/repository/infrastructure/repository';

type Options = {
  select?: 'base' | 'default';
};

export class ImageRepository extends Repository {
  private get baseImageSelect() {
    return this.dbRead
      .selectFrom('Image')
      .select((eb) => [
        'id',
        'name',
        'url',
        'nsfwLevel',
        'hash',
        'userId',
        'ingestion',
        'type',
        'width',
        'height',
        'metadata',
      ]);
  }

  private get imageSelect() {
    return this.baseImageSelect.select((eb) => [
      'meta', // TODO - select subset
      'postId',
      'scannedAt',
      'createdAt',
      'needsReview',
      'generationProcess',
    ]);
  }

  private buildSelect({ select = 'default' }: Options = {}) {
    switch (select) {
      case 'base':
        return this.baseImageSelect;
      case 'default':
        return this.imageSelect;
      default:
        throw new Error('not implemented');
    }
  }

  findByIdRef(foreignKey: Expression<number | null>, options?: Options) {
    return jsonObjectFrom(this.buildSelect(options).whereRef('Image.id', '=', foreignKey).limit(1));
  }

  findManyByIdRef(foreignKey: Expression<number | null>, options?: Options) {
    return jsonArrayFrom(this.buildSelect(options).whereRef('Image.id', '=', foreignKey));
  }

  findOne(id: number, options?: Options) {
    return this.buildSelect(options).where('Image.id', '=', id).executeTakeFirst();
  }

  findMany({ ids }: { ids: number[] }, options?: Options) {
    return this.buildSelect(options).where('Image.id', 'in', ids).execute();
  }
}

export const imageRepository = new ImageRepository();

export type BaseImageModel = InferResult<ImageRepository['baseImageSelect']>[number];
export type ImageModel = InferResult<ImageRepository['imageSelect']>[number];
