import { createNotificationsClient } from '@civitai/notifications';
import { env } from '$env/dynamic/private';
import { db } from '../db';
import { accessibleIds } from '../access';
import { BatchRejected, type SendBatch } from './notify.service';
import { isDefinitiveRejection } from './rejection';

// Lazy so a missing NOTIFICATIONS_ENDPOINT fails on the first send, not at boot.
let client: ReturnType<typeof createNotificationsClient> | undefined;

function notifications() {
  client ??= createNotificationsClient({
    endpoint: env.NOTIFICATIONS_ENDPOINT,
    token: env.NOTIFICATIONS_TOKEN,
    onFailure: (failure) =>
      console.error('knights: notifications-request-failed', {
        path: failure.path,
        status: failure.status,
        message: failure.message,
      }),
  });
  return client;
}

export const sendBatch: SendBatch = async (batch) => {
  try {
    await notifications().createNotificationsBulk([
      {
        key: batch.key,
        type: batch.type,
        category: 'Other',
        users: batch.userIds,
        details: {},
      },
    ]);
  } catch (error) {
    if (isDefinitiveRejection(error))
      throw new BatchRejected('batch not accepted', { cause: error });
    throw error;
  }
};

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
