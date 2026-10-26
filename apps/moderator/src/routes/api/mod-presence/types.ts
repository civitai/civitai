import type { Jsonified } from '$lib/format';
import type { WorkingNow, YouToday } from '$lib/server/moderation-board.service';

export type ModPresence = { working: WorkingNow[]; today: YouToday };

/** The same payload as the browser receives it — every `Date` has been through JSON. */
export type ModPresencePayload = Jsonified<ModPresence>;
