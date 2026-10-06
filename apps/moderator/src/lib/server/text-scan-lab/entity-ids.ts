import { MAX_INT4 } from '../users.service';

/** Ids separated by commas or whitespace, deduplicated. Every token must be an id: a typo silently
 *  dropped would act on fewer items than were asked for. Returns the refusal as a string. */
export function parseEntityIds(raw: string, max: number): number[] | string {
  const tokens = raw.split(/[\s,]+/).filter(Boolean);
  const bad = tokens.filter((t) => {
    const n = Number(t);
    return !/^\d+$/.test(t) || n < 1 || n > MAX_INT4;
  });
  if (bad.length) return `Not an id: ${bad.slice(0, 5).join(', ')}.`;
  const ids = [...new Set(tokens.map(Number))];
  if (!ids.length) return 'Enter at least one id.';
  if (ids.length > max) return `${ids.length} ids exceeds the limit of ${max} per request.`;
  return ids;
}
