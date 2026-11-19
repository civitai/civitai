import type { ComFace } from '$lib/com-face';

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
  /** Private models stay SFW-only: their lead applies when the model is published. */
  isPrivate: boolean;
  /** An earlier scan had already locked nsfw on this model; Keep lifts that lock. */
  systemLocked: boolean;
  /** The verdict was applied: at once on an SFW-only model (SFW-only cleared), or when the owner
   *  unticked minor/POI. Keep puts the owner's rating back. */
  autoApplied: boolean;
  /** Held as minor or POI, and the model has since been neither. */
  unticked: boolean;
  /** Who cleared the flag when it was not the owner's save; such a lead never applies by itself. */
  liftedBy: 'moderator' | 'appeal' | 'hashRevert' | null;
  heldAt: string | null;
  source: string | null;
  /** The text scan's own verdict row, when the text-scan path raised it. */
  scanLevel: number | null;
  scanLabels: string[];
  scanReason: string | null;
  /** XGuard forensics, when that path raised it. */
  forensics: { labels?: { label: string; score: number }[]; matchedTerms?: string[] } | null;
  /** The model's civitai.com face, null when it has none. */
  comFace: ComFace | null;
};

export const RULING_LABEL: Record<RestrictedVerdictRuling, string> = {
  keep: "Keep owner's rating",
  dismiss: 'Dismiss',
  rateNsfw: 'Rate NSFW',
};

export const LIFTED_NOTE: Record<NonNullable<RestrictedVerdictRow['liftedBy']> | 'owner', string> =
  {
    owner: 'owner has since unticked it',
    moderator: 'a moderator has since cleared it',
    appeal: 'since cleared on appeal',
    hashRevert: 'the automatic flag has since been reverted',
  };
