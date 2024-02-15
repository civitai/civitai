import { Context } from '~/server/createContext';
import {
  GetUserNotificationsSchema,
  ToggleNotificationSettingInput,
} from '~/server/schema/notification.schema';
import {
  createUserNotificationSetting,
  deleteUserNotificationSetting,
  getUserNotifications,
} from '~/server/services/notification.service';
import { throwDbError } from '~/server/utils/errorHandling';
import { DEFAULT_PAGE_SIZE } from '~/server/utils/pagination-helpers';

export const getUserNotificationsInfiniteHandler = async ({
  input,
  ctx,
}: {
  input: Partial<GetUserNotificationsSchema>;
  ctx: DeepNonNullable<Context>;
}) => {
  const { id: userId } = ctx.user;
  const limit = input.limit ?? DEFAULT_PAGE_SIZE;

  try {
    const { items } = await getUserNotifications({
      ...input,
      limit: limit + 1,
      userId,
    });

    let nextCursor: Date | undefined;
    if (items.length > limit) {
      const nextItem = items.pop();
      nextCursor = nextItem?.createdAt;
    }

    return { items, nextCursor };
  } catch (error) {
    throw throwDbError(error);
  }
};

export const upsertUserNotificationSettingsHandler = async ({
  input,
  ctx,
}: {
  input: ToggleNotificationSettingInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    if (input.toggle) {
      const deleted = await deleteUserNotificationSetting({ ...input, userId: ctx.user.id });
      return { deleted };
    }

    const notificationSetting = await createUserNotificationSetting({
      ...input,
      userId: ctx.user.id,
    });
    return { notificationSetting };
  } catch (error) {
    throw throwDbError(error);
  }
};
