import { Context } from '~/server/createContext';
import { throwDbError } from '~/server/utils/errorHandling';
import { GetLatestAnnouncementInput } from '~/server/schema/announcement.schema';
import { getLatestAnnouncement } from '~/server/services/announcement.service';

export type GetLatestAnnouncementProps = AsyncReturnType<typeof getLastestHandler>;
export const getLastestHandler = async ({
  input: { dismissed },
}: {
  ctx: Context;
  input: GetLatestAnnouncementInput;
}) => {
  try {
    return await getLatestAnnouncement({
      dismissed,
      select: {
        id: true,
        title: true,
        content: true,
        color: true,
        emoji: true,
      },
    });
  } catch (error) {
    throw throwDbError(error);
  }
};
