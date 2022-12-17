import { TRPCError } from '@trpc/server';
import { Context } from '~/server/createContext';
import {
  GetUserNotificationsSchema,
  MarkReadNotificationInput,
  ToggleNotificationSettingInput,
} from '~/server/schema/notification.schema';
import { getAllNotificationsSelect } from '~/server/selectors/notification.selector';
import {
  createUserNotificationSetting,
  deleteUserNotificationSetting,
  getUserNotifications,
  updateUserNoticationById,
} from '~/server/services/notification.service';
import { throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';
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
      select: getAllNotificationsSelect,
    });

    let nextCursor: string | undefined;
    if (items.length > limit) {
      const nextItem = items.pop();
      nextCursor = nextItem?.id;
    }

    return { items, nextCursor };
  } catch (error) {
    throw throwDbError(error);
  }
};

export const upsertUserNotificationSettingsHandler = async ({
  input,
}: {
  input: ToggleNotificationSettingInput;
}) => {
  try {
    if (input.toggle) {
      const deleted = await deleteUserNotificationSetting({ ...input });
      return { deleted };
    }

    const notificationSetting = await createUserNotificationSetting({ ...input });
    return { notificationSetting };
  } catch (error) {
    throw throwDbError(error);
  }
};

export const markReadNotificationHandler = async ({
  input,
}: {
  input: MarkReadNotificationInput;
}) => {
  try {
    const notification = await updateUserNoticationById({
      ...input,
      data: { viewedAt: new Date() },
    });

    if (!notification) throw throwNotFoundError(`No notification with id ${input.id}`);

    return { notification };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};
