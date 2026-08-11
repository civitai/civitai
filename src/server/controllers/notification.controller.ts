import type { ProtectedContext } from '~/server/createContext';
import type {
  GetUserNotificationsSchema,
  ToggleNotificationSettingInput,
} from '~/server/schema/notification.schema';
import {
  createUserNotificationSetting,
  deleteUserNotificationSetting,
  getUserNotifications,
} from '~/server/services/notification.service';
import { isOptInNotification } from '~/server/notifications/utils.notifications';
import { throwDbError } from '~/server/utils/errorHandling';
import { DEFAULT_PAGE_SIZE } from '~/server/utils/pagination-helpers';

export const getUserNotificationsInfiniteHandler = async ({
  input,
  ctx,
}: {
  input: Partial<GetUserNotificationsSchema>;
  ctx: ProtectedContext;
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
  ctx: ProtectedContext;
}) => {
  const userId = ctx.user.id;
  // `toggle` is the state the user asked for. A row means opted-OUT for almost every type, but
  // SUBSCRIBED for an opt-in one, so the same request writes in opposite directions per type.
  // Splitting here rather than at the call site keeps a raw type list (which is all the schema
  // accepts) from ever writing a row with the wrong polarity.
  const optIn = input.type.filter(isOptInNotification);
  const optOut = input.type.filter((type) => !isOptInNotification(type));

  const toRemove = input.toggle ? optOut : optIn;
  const toAdd = input.toggle ? optIn : optOut;

  try {
    const deleted = toRemove.length
      ? await deleteUserNotificationSetting({ ...input, type: toRemove, userId })
      : undefined;
    const notificationSetting = toAdd.length
      ? await createUserNotificationSetting({ ...input, type: toAdd, userId })
      : undefined;

    return { deleted, notificationSetting };
  } catch (error) {
    throw throwDbError(error);
  }
};
