import { Prisma } from '@prisma/client';
import { simpleUserSelect } from '~/server/selectors/user.selector';

export const getAllNotificationsSelect = Prisma.validator<Prisma.NotificationSelect>()({
  id: true,
  type: true,
  details: true,
  createdAt: true,
  viewedAt: true,
  user: { select: simpleUserSelect },
});
