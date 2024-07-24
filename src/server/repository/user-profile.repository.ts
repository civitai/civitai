import { InferResult } from 'kysely';
import { kyselyDbRead } from '~/server/kysely-db';
import { ImageRepository } from '~/server/repository/image.repository';

const userProfileSelect = kyselyDbRead
  .selectFrom('UserProfile')
  .select((eb) => [
    'bio',
    'coverImageId',
    'message',
    'messageAddedAt',
    'profileSectionsSettings',
    'privacySettings',
    'showcaseItems',
    'location',
    'nsfw',
    'userId',
    ImageRepository.findOneListImageByIdRef(eb.ref('UserProfile.coverImageId')).as('coverImage'),
  ]);

export type UserProfileModel = InferResult<typeof userProfileSelect>;

// type FindOneArgs = { userId?: number; username?: never } | { userId?: never; username?: string };

export class UserProfileRepository {
  static async findOne(userId: number) {
    return await userProfileSelect.where('UserProfile.userId', '=', userId);
  }
}
