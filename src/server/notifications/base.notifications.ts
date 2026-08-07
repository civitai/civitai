import * as z from 'zod';
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
  /**
   * Inverts what a `UserNotificationSettings` row MEANS for this type: subscribed, rather than the
   * global default of opted-out. A processor may only set this if its query derives recipients by
   * joining that table (`cosmetic-shop-item-added-to-section` is the only one) — pairing it with the
   * usual `NOT EXISTS` clause ships the notification ON while the UI renders it OFF.
   *
   * Read by the toggle handler, not just the UI, so a row is never written with the wrong polarity.
   * Opt-in types are excluded from the bulk on/off toggles: those pass a raw type list, and an INSERT
   * meant as "off" would subscribe the user instead.
   */
  optIn?: boolean;
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
