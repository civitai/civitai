import { InferResult } from 'kysely';
import { kyselyDbRead } from '~/server/kysely-db';
import { Image } from '~/server/repository/image.repository';

export type UserProfileModel = InferResult<(typeof UserProfileRepository)['userProfileSelect']>;

export class UserProfileRepository {
  // #region [select]
  private static get userProfileSelect() {
    return kyselyDbRead
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
        Image.findOneFeedImageByIdRef(eb.ref('UserProfile.coverImageId')).as('coverImage'),
      ]);
  }
  // #endregion

  // #region [helpers]

  // #endregion

  // #region [main]
  static async findOne(userId: number) {
    return await this.userProfileSelect.where('UserProfile.userId', '=', userId);
  }
  // #endregion
}
