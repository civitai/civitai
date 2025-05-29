import { z } from 'zod';
import type { CustomClickHouseClient } from '~/server/clickhouse/client';
import type { NotificationCategory } from '~/server/common/enums';

export type NotificationProcessor = {
  displayName: string;
  priority?: number;
  toggleable?: boolean;
  prepareQuery?: (input: NotificationProcessorRunInput) => Promise<string | undefined> | string;
  prepareMessage: (notification: Omit<BareNotification, 'id'>) => NotificationMessage | undefined;
  getDetails?: (notifications: BareNotification[]) => BareNotification[];
  category: NotificationCategory;
  defaultDisabled?: boolean;
  showCategory?: boolean;
};

export const bareNotification = z.object({
  id: z.number(),
  type: z.string(),
  details: z.record(z.string(), z.any()),
});
export type BareNotification = z.infer<typeof bareNotification>;

type NotificationMessage = {
  message: string;
  url?: string;
  target?: '_blank' | '_self';
};
export type NotificationProcessorRunInput = {
  lastSent: string;
  lastSentDate: Date;
  clickhouse: CustomClickHouseClient | undefined;
};

export function createNotificationProcessor(processor: Record<string, NotificationProcessor>) {
  return processor;
}
