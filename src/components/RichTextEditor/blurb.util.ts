import { getDisplayName, removeTags } from '~/utils/string-helpers';

export type BlurbItem = {
  id: number;
  name: string;
  content: string;
  referenceCount: number;
  referencesByEntityType: Record<string, number>;
};

export function blurbPreview(content: string) {
  return removeTags(content);
}

export function usesLabel(count: number) {
  if (count === 0) return 'Not used yet';
  return count === 1 ? '1 use' : `${count} uses`;
}

export function placesLabel(count: number) {
  return count === 1 ? '1 place' : `${count} places`;
}

/** `38 models, 2 articles, 1 bounty` — the per-surface reach shown before an edit is saved. */
export function usageBreakdown(referencesByEntityType: Record<string, number>) {
  return Object.entries(referencesByEntityType)
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a)
    .map(([entityType, count]) => {
      const noun = getDisplayName(entityType).toLowerCase();
      return `${count} ${count === 1 ? noun : `${noun}s`}`;
    })
    .join(', ');
}

export function matchBlurbs(blurbs: BlurbItem[], query: string, limit = 8) {
  const normalized = query.trim().toLowerCase();
  const matched = !normalized
    ? blurbs
    : blurbs.filter(
        (blurb) =>
          blurb.name.toLowerCase().includes(normalized) ||
          blurbPreview(blurb.content).toLowerCase().includes(normalized)
      );
  return matched.slice(0, limit);
}
