export type Restriction = 'minor' | 'poi' | 'sfwOnly';
export const RESTRICTED_VERDICT_RULINGS = ['keep', 'dismiss', 'rateNsfw'] as const;
export type RestrictedVerdictRuling = (typeof RESTRICTED_VERDICT_RULINGS)[number];

/** A model the text scan rated NSFW while its owner had it marked minor, POI or SFW-only. The scan
 *  left nsfw alone and wrote `meta.restrictedNsfwVerdict` (main app, `holdRestrictedVerdict`). */
export type RestrictedVerdictRow = {
  modelId: number;
  modelName: string;
  userId: number;
  username: string | null;
  /** Minor wins over POI over SFW-only; a lead held as minor stays minor after the owner unticks it. */
  restriction: Restriction;
  minor: boolean;
  poi: boolean;
  sfwOnly: boolean;
  nsfw: boolean;
  /** An earlier scan had already locked nsfw on this model; Keep lifts that lock. */
  systemLocked: boolean;
  heldAt: string | null;
  source: string | null;
  /** The text scan's own verdict row, when the text-scan path raised it. */
  scanLevel: number | null;
  scanLabels: string[];
  scanReason: string | null;
  /** XGuard forensics, when that path raised it. */
  forensics: { labels?: { label: string; score: number }[]; matchedTerms?: string[] } | null;
};

export const RULING_LABEL: Record<RestrictedVerdictRuling, string> = {
  keep: "Keep owner's rating",
  dismiss: 'Dismiss',
  rateNsfw: 'Rate NSFW',
};
