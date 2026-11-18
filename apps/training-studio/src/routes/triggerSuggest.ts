import { JUNK_TAGS, normTag } from '$lib/autolabel-exclude';
import type { LabelType } from '$lib/data/trainingModels';
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

/** The trigger word a tagged dataset's captions imply: a first tag shared, in any casing (but spelled the
 *  same: `my_char` and `my char` are two tags to the trainer), by at least `SHARE` of the non-empty `captions`
 *  and not a generic lead tag. Uncaptioned files don't count: auto-label tags
 *  them later. Returned in its most-used casing; null when nothing qualifies or fewer than two captions agree. */
export function suggestTrigger(captions: string[]): string | null {
  const tagged = captions.filter((c) => splitTags(c).length > 0);
  if (tagged.length < 2) return null;
  const firsts = new Map<string, { count: number; casings: Map<string, number> }>();
  for (const caption of tagged) {
    const first = splitTags(caption)[0]!;
    const key = first.toLowerCase();
    let f = firsts.get(key);
    if (!f) firsts.set(key, (f = { count: 0, casings: new Map() }));
    f.count++;
    f.casings.set(first, (f.casings.get(first) ?? 0) + 1);
  }
  for (const [key, { count, casings }] of firsts) {
    if (count / tagged.length < SHARE) continue;
    if (GENERIC_LEAD_TAGS.has(normTag(key)) || COUNT_TAG.test(key)) return null;
    return [...casings.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  }
  return null;
}

/** What a zip import fills into the trigger field, or null to leave it alone: tag mode only (a caption's
 *  first clause is not a tag), and only into an empty field, so a trigger the user typed or cleared after
 *  an earlier fill in the same import is never overwritten. */
export function triggerForImport(o: {
  labelMode: LabelType;
  trigger: string;
  mayFill: boolean;
  captions: string[];
}): string | null {
  if (o.labelMode !== 'tag' || !o.mayFill || o.trigger.trim()) return null;
  return suggestTrigger(o.captions);
}
