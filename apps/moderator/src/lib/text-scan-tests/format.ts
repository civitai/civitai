/** `1 case`, `2 cases`. */
export function countOf(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** Prompt versions as `key#id`; id 0 is the unsaved draft, shown as `key (draft)`. */
export function formatVersions(promptIds: Record<string, number>): string {
  return Object.entries(promptIds)
    .map(([key, id]) => (id === 0 ? `${key} (draft)` : `${key}#${id}`))
    .join(' ');
}
