import { createNotificationsClient } from '@civitai/notifications';
import { env } from '$env/dynamic/private';
import { db } from '../db';
import { accessibleIds } from '../access';
import type { SendBatch } from './notify.service';
import { clientConfig, makeSendBatch } from './sender';

// Lazy so a missing NOTIFICATIONS_ENDPOINT fails on the first send, not at boot.
let client: ReturnType<typeof createNotificationsClient> | undefined;

const notifications = () => (client ??= createNotificationsClient(clientConfig(env)));

export const sendBatch: SendBatch = makeSendBatch((rows) =>
  notifications().createNotificationsBulk(rows)
);

const MODERATOR_LOOKUP_CHUNK = 5000;

/** Moderators are always let in; for everyone else the app's access flag decides, as for a signed-in player. */
export async function accessibleToday(ids: number[]): Promise<number[]> {
  const users: { id: number; isModerator: boolean }[] = [];
  for (let at = 0; at < ids.length; at += MODERATOR_LOOKUP_CHUNK) {
    const rows = await db
      .selectFrom('User')
      .select(['id', 'isModerator'])
      .where('id', 'in', ids.slice(at, at + MODERATOR_LOOKUP_CHUNK))
      .execute();
    users.push(...rows.map((r) => ({ id: r.id, isModerator: r.isModerator === true })));
  }
  return accessibleIds(users);
}
