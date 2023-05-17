import { ClickHouseClient } from '@clickhouse/client';

export type NotificationProcessor = {
  displayName: string;
  priority?: number;
  toggleable?: boolean;
  prepareQuery?: (input: NotificationProcessorRunInput) => Promise<string> | string;
  prepareMessage: (notification: BareNotification) => NotificationMessage | undefined;
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
  clickhouse: ClickHouseClient | null;
};

export function createNotificationProcessor(processor: Record<string, NotificationProcessor>) {
  return processor;
}
