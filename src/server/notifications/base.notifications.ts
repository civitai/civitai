import { PrismaClient } from '@prisma/client';

type NotificationProcessor = {
  run: (
    input: NotificationProcessorRunInput,
    ctx: NotificationProcessorContext
  ) => Promise<NotificationProcessorResult>;
  types?: Record<string, NotificationMessagePreparer>;
};

type NotificationMessagePreparer = {
  run: (notification: BareNotification) => NotificationMessage;
  displayName: string;
};

type NotificationProcessorContext = {
  prisma: PrismaClient;
};

export type BareNotification = {
  type: string;
  details: MixedObject;
};
type NotificationMessage = {
  message: string;
  url?: string;
};
export type NotificationProcessorRunInput = {
  lastSent: Date;
};

type NotificationProcessorResult = {
  success: boolean;
  sent: Record<string, number>;
};

export function createNotificationProcessor(
  run: NotificationProcessor['run'],
  types: NotificationProcessor['types']
): NotificationProcessor {
  return {
    run,
    types,
  };
}
