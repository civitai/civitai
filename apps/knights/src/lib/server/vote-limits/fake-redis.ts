import type { GateClient } from './gate';

/** The few Redis commands the gate uses, with a clock the test moves. */
export function fakeRedis() {
  const clock = { now: 0 };
  const values = new Map<string, { value: number | string; expiresAt: number | null }>();
  const live = (key: string) => {
    const entry = values.get(key);
    if (entry && entry.expiresAt !== null && entry.expiresAt <= clock.now) values.delete(key);
    return values.get(key);
  };
  const client: GateClient = {
    async incr(key) {
      const next = Number(live(key)?.value ?? 0) + 1;
      values.set(key, { value: next, expiresAt: live(key)?.expiresAt ?? null });
      return next;
    },
    async decr(key) {
      const next = Number(live(key)?.value ?? 0) - 1;
      values.set(key, { value: next, expiresAt: live(key)?.expiresAt ?? null });
      return next;
    },
    async pExpire(key, ms) {
      const entry = live(key);
      if (entry) entry.expiresAt = clock.now + ms;
      return entry ? 1 : 0;
    },
    async pTTL(key) {
      const entry = live(key);
      if (!entry) return -2;
      return entry.expiresAt === null ? -1 : entry.expiresAt - clock.now;
    },
    async set(key, value, options) {
      values.set(key, { value, expiresAt: options?.PX ? clock.now + options.PX : null });
      return 'OK';
    },
    async del(key) {
      return values.delete(key) ? 1 : 0;
    },
  };
  return { client, clock, values };
}
