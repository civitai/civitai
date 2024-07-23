import { imageRepository } from '~/server/repository/image.repository';
import { Repository } from '~/server/repository/infrastructure/repository';

class UserProfileRepository extends Repository {
  private get userProfileSelect() {
    this.dbRead.selectFrom('UserProfile').select((eb) => []);
  }

  private buildQuery() {
    return this.dbRead.selectFrom('UserProfile').select((eb) => [
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
      // imageRepository.findManyByRef('UserProfile.coverImageId').as('coverImage'),
      imageRepository.findByIdRef(eb.ref('UserProfile.coverImageId')).as('coverImage'),
      // jsonObjectFrom(eb.selectFrom('Image').select(['id']).whereRef()).as('cosmetic'),
    ]);
  }

  // async findOne(userId: number) {}

  async findMany(userIds: number[]) {
    return await this.buildQuery().select(['userId']).where('userId', 'in', userIds).execute();
  }
}

export const userProfileRepository = new UserProfileRepository();
