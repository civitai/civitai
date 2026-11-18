import { REDIS_SYS_KEYS, type RedisKeyTemplateSys } from '@civitai/redis';
import { getSysRedis } from '../redis';

const KEY = REDIS_SYS_KEYS.APP.CASES_SENDS_PAUSED as RedisKeyTemplateSys;

export type BrakeState =
  | { paused: true; by: number | 'system'; at: string; reason: string }
  | { paused: false };

/**
 * Whether case notices may be sent. Read before every message.
 *
 * 🔴 FAILS CLOSED: if Redis can't be read, the answer is "paused". A brake that reads as off when its
 * store is down is no brake.
 */
export async function readBrake(): Promise<BrakeState> {
  try {
    const raw = await getSysRedis().get(KEY);
    if (!raw) return { paused: false };
    const parsed = JSON.parse(raw) as Omit<Extract<BrakeState, { paused: true }>, 'paused'>;
    return { paused: true, ...parsed };
  } catch {
    return { paused: true, by: 'system', at: new Date().toISOString(), reason: 'brake unreadable' };
  }
}

/** Any `cases.act` holder may pause. */
export async function pauseSends(by: number | 'system', reason: string) {
  await getSysRedis().set(KEY, JSON.stringify({ by, at: new Date().toISOString(), reason }));
}

/** Only a `cases.unpause` holder may clear it; the caller checks the grant. */
export async function resumeSends() {
  await getSysRedis().del(KEY);
}
