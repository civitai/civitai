const NAMES: Record<string, string> = {
  PG: 'Safe for all',
  'PG-13': 'Suggestive',
  R: 'Mature',
  X: 'Explicit',
  XXX: 'Hardcore',
  Blocked: 'Not allowed',
};

/** The short name shown above a level's description in the rating guide, keyed by the level's label. */
export const levelName = (label: string): string | null => NAMES[label] ?? null;
