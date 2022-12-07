type NotificationProcessor = {
  run: (input: NotificationProcessorRunInput) => Promise<NotificationProcessorResult>;
  types?: Record<string, (notification: Notification) => NotificationMessage>;
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
