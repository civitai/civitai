import { createHmac } from 'node:crypto';

/**
 * The name a queue item goes by on the public queue topics: anyone signed in can subscribe to a topic, so a drop must not reveal
 * an item or image id. Stable across players, so one announcement reaches every buffer that holds the item.
 */
export const liveKey = (secret: string, itemId: number) =>
  createHmac('sha256', secret).update(`live:${itemId}`).digest('base64url').slice(0, 16);
