import { ClickHouseClient } from '@clickhouse/client';
import { NotificationCategory } from '@prisma/client';

export type NotificationProcessor = {
  displayName: string;
  priority?: number;
  toggleable?: boolean;
  prepareQuery?: (input: NotificationProcessorRunInput) => Promise<string> | string;
  prepareMessage: (notification: Omit<BareNotification, 'id'>) => NotificationMessage | undefined;
  getDetails?: (notifications: BareNotification[]) => BareNotification[];
  category: NotificationCategory;
  defaultDisabled?: boolean;
};

export type BareNotification = {
  id: string;
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
  clickhouse: ClickHouseClient | undefined;
  category: NotificationCategory;
};

export function createNotificationProcessor(processor: Record<string, NotificationProcessor>) {
  return processor;
}
