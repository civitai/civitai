import type { PromptIds } from '~/server/services/text-scan/types';

export const TEXT_SCAN_FLAGS_KEY = 'textScanFlags';

export const TEXT_SCAN_FLAG_LABELS = ['poi', 'minor'] as const;
export type TextScanFlagLabel = (typeof TEXT_SCAN_FLAG_LABELS)[number];

export const MAX_FLAG_REASON_CHARS = 300;
export const MAX_FLAG_NAMES = 10;
export const MAX_FLAG_NAME_CHARS = 100;

export type TextScanFlagDecision = {
  at: string;
  by: number;
  textHash?: string | null;
  via?: 'appeal' | 'moderator';
  /** A held-detection ruling's reason slug from `@civitai/shared/resolution-reasons`, and its note. */
  reason?: string;
  note?: string;
};

export type TextScanFlagRuling = TextScanFlagDecision & {
  decision: 'appealGranted' | 'appealUpheld';
};

// The newest rulings a flag write carries forward. Model.meta rides on every feed row, so the
// history is bounded.
export const MAX_FLAG_RULINGS = 5;

// `first`: no human ruling behind it, held because the label is in review mode. `redetected`: text a
// human already cleared under another hash. A marker without `kind` predates this field and is a
// re-detection.
export type HeldDetectionKind = 'first' | 'redetected';

// A held detection. It sets nothing and tells nobody: a moderator decides whether it stands.
export type TextScanRedetection = {
  kind?: HeldDetectionKind;
  at?: string;
  workflowId: string;
  reason?: string;
  names?: string[];
  textHash: string;
  promptIds?: PromptIds | null;
  model?: string | null;
};

export type TextScanFlagEntry = {
  at?: string;
  workflowId?: string;
  reason?: string;
  names?: string[];
  textHash?: string;
  promptIds?: PromptIds | null;
  model?: string | null;
  prev?: {
    nsfw?: boolean;
    sfwOnly?: boolean;
    galleryLevel?: number | null;
    lockedProperties?: string[];
    availability?: string;
  };
  appealGranted?: TextScanFlagDecision;
  appealUpheld?: TextScanFlagDecision;
  redetected?: TextScanRedetection;
  rulings?: TextScanFlagRuling[];
};

export type TextScanFlags = Partial<Record<TextScanFlagLabel, TextScanFlagEntry>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function readTextScanFlags(meta: unknown): TextScanFlags {
  if (!isRecord(meta)) return {};
  const flags = meta[TEXT_SCAN_FLAGS_KEY];
  return isRecord(flags) ? (flags as TextScanFlags) : {};
}

// A ruling stub (a moderator's unset, or an overturn of a label the scan never flagged) carries
// only `appealGranted` and no workflowId: it is not a verdict.
export function hasTextScanVerdict(meta: unknown, label: TextScanFlagLabel): boolean {
  return !!readTextScanFlags(meta)[label]?.workflowId;
}

export function hasOpenTextScanFlag(meta: unknown, label: TextScanFlagLabel): boolean {
  const entry = readTextScanFlags(meta)[label];
  return !!entry?.workflowId && !entry.appealGranted;
}

export function getTextScanRedetection(
  meta: unknown,
  label: TextScanFlagLabel
): TextScanRedetection | null {
  const redetected = readTextScanFlags(meta)[label]?.redetected;
  return redetected?.workflowId && redetected.textHash ? redetected : null;
}

export function appealGrantCoversText(
  meta: unknown,
  label: TextScanFlagLabel,
  textHash: string
): boolean {
  const grant = readTextScanFlags(meta)[label]?.appealGranted;
  return !!grant?.textHash && grant.textHash === textHash;
}

// Model.meta is selected on every feed row, so the persisted verdict is capped.
export function buildTextScanFlagEntry({
  workflowId,
  reason,
  names,
  textHash,
}: {
  workflowId: string;
  reason: string;
  names?: string[];
  textHash: string;
}) {
  const entry: { workflowId: string; reason: string; names?: string[]; textHash: string } = {
    workflowId,
    reason: reason.trim().slice(0, MAX_FLAG_REASON_CHARS),
    textHash,
  };
  if (names) {
    entry.names = [...new Set(names.map((name) => name.trim()).filter(Boolean))]
      .slice(0, MAX_FLAG_NAMES)
      .map((name) => name.slice(0, MAX_FLAG_NAME_CHARS));
  }
  return entry;
}

export function withTextScanDecision(
  meta: unknown,
  label: TextScanFlagLabel,
  key: 'appealGranted' | 'appealUpheld',
  decision: TextScanFlagDecision
): Record<string, unknown> {
  const base = isRecord(meta) ? meta : {};
  const flags = readTextScanFlags(meta);
  return {
    ...base,
    [TEXT_SCAN_FLAGS_KEY]: { ...flags, [label]: { ...flags[label], [key]: decision } },
  };
}

export function isModelFlagAppealable(model: { minor: boolean; poi: boolean; meta: unknown }) {
  const hasMinorSnapshot = isRecord(model.meta) && !!model.meta.minorFlagSnapshot;
  return (
    (model.minor && (hasMinorSnapshot || hasOpenTextScanFlag(model.meta, 'minor'))) ||
    (model.poi &&
      ((isRecord(model.meta) && !!model.meta.poiFlagSnapshot) ||
        hasOpenTextScanFlag(model.meta, 'poi')))
  );
}

// Hidden by a text-scan poi flag no appeal has granted. Such a bounty never pays out.
export function isTextScanPoiHidden(bounty: { poi: boolean; availability: string; meta: unknown }) {
  return bounty.poi && bounty.availability === 'Private' && hasOpenTextScanFlag(bounty.meta, 'poi');
}

export function isBountyFlagAppealable(bounty: { poi: boolean; meta: unknown }) {
  return bounty.poi && hasOpenTextScanFlag(bounty.meta, 'poi');
}

export type FlagScanReason = { label: TextScanFlagLabel; reason: string; names: string[] };

export function resolveFlagScanReasons({
  isOwner,
  poi,
  minor,
  meta,
}: {
  isOwner: boolean | null | undefined;
  poi: boolean | null | undefined;
  minor: boolean | null | undefined;
  meta: unknown;
}): FlagScanReason[] {
  if (!isOwner) return [];
  const flags = readTextScanFlags(meta);
  const set = { minor: !!minor, poi: !!poi };
  return (['minor', 'poi'] as const).flatMap((label) => {
    const entry = flags[label];
    if (!set[label] || !hasOpenTextScanFlag(meta, label) || !entry?.reason) return [];
    return [{ label, reason: entry.reason, names: entry.names ?? [] }];
  });
}
