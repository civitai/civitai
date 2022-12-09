type NotificationProcessor = {
  displayName: string;
  prepareQuery?: (input: NotificationProcessorRunInput) => string;
  prepareMessage: (notification: BareNotification) => NotificationMessage;
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
  lastSent: string;
};

export function createNotificationProcessor(processor: Record<string, NotificationProcessor>) {
  return processor;
}
