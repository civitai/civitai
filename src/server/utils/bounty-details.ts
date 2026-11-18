import { filterSensitiveProfanityData } from '~/libs/profanity-simple/helpers';

/**
 * The details key the text scan writes when it flags a bounty (text-scan/actions/bounty-nsfw.ts). No
 * client sets it, a moderator unflagging the bounty in its editor clears it, and only moderators are
 * sent it.
 */
export const BOUNTY_SCAN_DETAILS_KEY = 'textScanNsfw';
const SCAN_KEY = BOUNTY_SCAN_DETAILS_KEY;

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
