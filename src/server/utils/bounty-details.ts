import { filterSensitiveProfanityData } from '~/libs/profanity-simple/helpers';

// Written only by the text scan when it flags a bounty (text-scan/actions/bounty-nsfw.ts). No client
// sets or clears it, and only moderators are sent it.
const SCAN_KEY = 'textScanNsfw';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A bounty's details as the viewer may see them. */
export function publicBountyDetails<T>(details: T, isModerator?: boolean): T {
  const filtered = filterSensitiveProfanityData(details as never, isModerator) as T;
  if (isModerator || !isObject(filtered) || !(SCAN_KEY in filtered)) return filtered;
  const { [SCAN_KEY]: _scan, ...rest } = filtered;
  return rest as T;
}

/** Details from a client, with the scan's record taken from `stored` instead (none on create). */
export function withStoredScanDetails<T>(incoming: T, stored: unknown): T {
  const storedScan = isObject(stored) ? stored[SCAN_KEY] : undefined;
  const kept = storedScan === undefined ? {} : { [SCAN_KEY]: storedScan };
  if (!isObject(incoming)) return (storedScan === undefined ? incoming : kept) as T;
  const { [SCAN_KEY]: _scan, ...rest } = incoming;
  return { ...rest, ...kept } as T;
}
