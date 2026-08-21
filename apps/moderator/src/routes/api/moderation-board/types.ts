import type { Jsonified } from '$lib/format';
import type {
  AutoBlockedUser,
  QueueActivity,
  SweepCount,
  TaskLag,
} from '$lib/server/moderation-board.service';

/** What the handler returns. Derived from the service rows rather than hand-copied — a type import is
 *  erased and pulls no database client into the client bundle. The copy this replaces drifted twice in
 *  one day: once when `contextUrl` was added, once when `activity` stopped being a map. */
export type BoardResponse = {
  activity: QueueActivity[];
  lag: TaskLag[];
  sweeps: SweepCount[];
  autoBlocked: AutoBlockedUser[];
};

/** The same payload as the browser receives it — every `Date` has been through JSON. */
export type BoardPayload = Jsonified<BoardResponse>;
