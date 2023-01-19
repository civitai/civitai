export type NotificationProcessor = {
  displayName: string;
  priority?: number;
  toggleable?: boolean;
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
  target?: '_blank' | '_self';
};
export type NotificationProcessorRunInput = {
  lastSent: string;
};

export function createNotificationProcessor(processor: Record<string, NotificationProcessor>) {
  return processor;
}
