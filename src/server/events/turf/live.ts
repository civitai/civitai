import { loadEvents } from '~/server/events/load-events';
import { applyTurfOverride, turfConfigKey } from '~/server/events/turf/config';
import { sysRedis } from '~/server/redis/client';

/** Whether any event's Hat Turf is open to everyone now: running, in live mode. False on any error. */
export async function isHatTurfLive(now = new Date()) {
  try {
    for (const event of await loadEvents()) {
      if (!event.turf || now < event.startDate || now >= event.endDate) continue;
      const raw = await sysRedis.get(turfConfigKey(event.name)).catch(() => null);
      if (applyTurfOverride(event.turf, raw).config.mode === 'live') return true;
    }
  } catch {
    // The unlock list must not fail for it.
  }
  return false;
}
