import { JUNK_TAGS, normTag } from '$lib/autolabel-exclude';
import { splitTags } from './trainingFlow';

/** Lead tags a tagger puts first on most images of any dataset, so they say nothing about a trigger word. */
const GENERIC_LEAD_TAGS = new Set(
  [
    'solo',
    'multiple girls',
    'multiple boys',
    'no humans',
    'anime screencap',
    'male focus',
    'female focus',
    'looking at viewer',
    'simple background',
    'white background',
    'monochrome',
    'greyscale',
    ...JUNK_TAGS,
  ].map(normTag)
);
// 1girl, 2boys, 6+girls, 1other.
const COUNT_TAG = /^\d+\+?(girl|boy|other)s?$/;

const SHARE = 0.75;

/** The trigger word a tagged dataset's captions imply: a first tag shared, in any casing, by at least 75%
 *  of the non-empty `captions` and not a generic lead tag. Uncaptioned files don't count: auto-label tags
 *  them later. Returned in its most-used casing; null when nothing qualifies or fewer than two captions agree. */
export function suggestTrigger(captions: string[]): string | null {
  const tagged = captions.filter((c) => splitTags(c).length > 0);
  if (tagged.length < 2) return null;
  const firsts = new Map<string, { count: number; casings: Map<string, number> }>();
  for (const caption of tagged) {
    const first = splitTags(caption)[0]!;
    const key = normTag(first);
    let f = firsts.get(key);
    if (!f) firsts.set(key, (f = { count: 0, casings: new Map() }));
    f.count++;
    f.casings.set(first, (f.casings.get(first) ?? 0) + 1);
  }
  for (const [key, { count, casings }] of firsts) {
    if (count / tagged.length < SHARE) continue;
    if (GENERIC_LEAD_TAGS.has(key) || COUNT_TAG.test(key)) return null;
    return [...casings.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  }
  return null;
}
