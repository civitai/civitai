import { parseStoredCandidate } from '~/shared/utils/comic-candidates';

/**
 * The panel metadata a comic workspace read returns: a fixed set of keys, so nothing a writer adds
 * later reaches the client unreviewed.
 */

const SCALAR_KEYS = [
  'enhanceEnabled',
  'useContext',
  'referencePanelId',
  'includePreviousImage',
  'quantity',
  'blockedReason',
] as const;

const GENERATION_PARAM_KEYS = [
  'engine',
  'baseModel',
  'checkpointVersionId',
  'width',
  'height',
  'prompt',
  'negativePrompt',
] as const;

type Scalar = string | number | boolean | null;
const isScalar = (value: unknown): value is Scalar =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export type ViewerCandidate = {
  key?: string;
  requiresUnlock?: true;
  blockedReason?: string;
  nsfwLevel: number | null;
};

type ViewerRules = {
  isOwner: boolean;
  keepSourceImage: (value: string) => boolean;
  keepCandidateKey: (key: string, nsfwLevel: number | null) => boolean;
  keepSelectedImageId: (id: number) => boolean;
};

function viewerCandidate(
  entry: unknown,
  { isOwner, keepCandidateKey }: ViewerRules
): ViewerCandidate | null {
  const stored = parseStoredCandidate(entry);
  if (!stored) return null;
  const { key, nsfwLevel } = stored;
  if (stored.locked) {
    return { requiresUnlock: true, blockedReason: stored.blockedReason ?? 'canUpgrade', nsfwLevel };
  }
  if (!isOwner || !key) return { nsfwLevel };
  if (!keepCandidateKey(key, nsfwLevel)) {
    return { requiresUnlock: true, blockedReason: 'siteRestricted', nsfwLevel };
  }
  return { key, nsfwLevel };
}

/** The stored `sourceImageUrl` of a panel's metadata, in the form it was written. */
export function panelSourceImageUrl(metadata: unknown): string | null {
  return isRecord(metadata) && typeof metadata.sourceImageUrl === 'string'
    ? metadata.sourceImageUrl
    : null;
}

/** Every key a panel's stored candidates hold, locked ones included. */
export function candidateKeys(metadata: unknown): string[] {
  if (!isRecord(metadata) || !Array.isArray(metadata.candidateImages)) return [];
  return metadata.candidateImages.flatMap((entry) => parseStoredCandidate(entry)?.key ?? []);
}

/** The numeric `selectedImageIds` of a panel's metadata. */
export function selectedImageIdsOf(metadata: unknown): number[] {
  if (!isRecord(metadata) || !Array.isArray(metadata.selectedImageIds)) return [];
  return metadata.selectedImageIds.filter((id): id is number => typeof id === 'number');
}

/**
 * `metadata` reduced to the keys the workspace reads. Unknown keys are dropped. Candidate keys go to
 * the project owner only, never for a locked candidate, and only when `keepCandidateKey` passes;
 * a withheld one becomes a locked slot. `sourceImageUrl` and `selectedImageIds` are kept only as far
 * as their rules say the image may be shown to this viewer.
 */
export function viewerPanelMetadata(
  metadata: unknown,
  rules: ViewerRules
): Record<string, unknown> | null {
  if (!isRecord(metadata)) return null;
  const out: Record<string, unknown> = {};
  for (const key of SCALAR_KEYS) {
    if (key in metadata && isScalar(metadata[key])) out[key] = metadata[key];
  }
  if (Array.isArray(metadata.selectedImageIds)) {
    out.selectedImageIds = selectedImageIdsOf(metadata).filter(rules.keepSelectedImageId);
  }
  if (isRecord(metadata.generationParams)) {
    const params: Record<string, Scalar> = {};
    for (const key of GENERATION_PARAM_KEYS) {
      const value = metadata.generationParams[key];
      if (isScalar(value)) params[key] = value;
    }
    out.generationParams = params;
  }
  if (Array.isArray(metadata.candidateImages)) {
    out.candidateImages = metadata.candidateImages
      .map((entry) => viewerCandidate(entry, rules))
      .filter((entry): entry is ViewerCandidate => entry !== null);
  }
  const source = panelSourceImageUrl(metadata);
  out.hasSourceImage = !!source;
  if (source && rules.keepSourceImage(source)) out.sourceImageUrl = source;
  return out;
}
