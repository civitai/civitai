import {
  freezeCruciblePlacements,
  readFlagRaceConfig,
  type FreezeEvent,
} from '~/server/events/scoring/award-results';
import { freezeFlagDays } from '~/server/events/turf/flag-freeze';
import { logToAxiom } from '~/server/logging/client';

// Kept out of award-results: flag-freeze loads the event registry, and award-results must stay
// below it (docs/dev/import-cycles.md).

/**
 * The settle's freeze step. A failure is logged and skipped: nothing is lost, the next settle freezes
 * it, and the award still counts from its own date.
 */
export async function freezeEventAwards(event: FreezeEvent, now = new Date()) {
  try {
    const config = await readFlagRaceConfig(event.name);
    const places = await freezeCruciblePlacements(event, config);
    if (!config.flags) return places;
    return places + (await freezeFlagDays(event, config.flags, now));
  } catch (error) {
    logToAxiom({
      type: 'error',
      name: 'event-award-freeze-failed',
      event: event.name,
      error,
    });
    return 0;
  }
}
