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

function viewerCandidate(entry: unknown, isOwner: boolean): ViewerCandidate | null {
  if (typeof entry === 'string')
    return isOwner ? { key: entry, nsfwLevel: null } : { nsfwLevel: null };
  if (!isRecord(entry)) return null;
  const nsfwLevel = typeof entry.nsfwLevel === 'number' ? entry.nsfwLevel : null;
  if (entry.requiresUnlock) {
    return {
      requiresUnlock: true,
      blockedReason: typeof entry.blockedReason === 'string' ? entry.blockedReason : 'canUpgrade',
      nsfwLevel,
    };
  }
  if (!isOwner || typeof entry.key !== 'string') return { nsfwLevel };
  return { key: entry.key, nsfwLevel };
}

/** The stored `sourceImageUrl` of a panel's metadata, in the form it was written. */
export function panelSourceImageUrl(metadata: unknown): string | null {
  return isRecord(metadata) && typeof metadata.sourceImageUrl === 'string'
    ? metadata.sourceImageUrl
    : null;
}

/**
 * `metadata` reduced to the keys the workspace reads. Unknown keys are dropped. Candidate keys go to
 * the project owner only, and never for a locked candidate. `sourceImageUrl` is kept only when
 * `keepSourceImage` says its image may be shown to this viewer.
 */
export function viewerPanelMetadata(
  metadata: unknown,
  { isOwner, keepSourceImage }: { isOwner: boolean; keepSourceImage: (value: string) => boolean }
): Record<string, unknown> | null {
  if (!isRecord(metadata)) return null;
  const out: Record<string, unknown> = {};
  for (const key of SCALAR_KEYS) {
    if (key in metadata && isScalar(metadata[key])) out[key] = metadata[key];
  }
  if (Array.isArray(metadata.selectedImageIds)) {
    out.selectedImageIds = metadata.selectedImageIds.filter((id) => typeof id === 'number');
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
      .map((entry) => viewerCandidate(entry, isOwner))
      .filter((entry): entry is ViewerCandidate => entry !== null);
  }
  const source = panelSourceImageUrl(metadata);
  if (source && keepSourceImage(source)) out.sourceImageUrl = source;
  return out;
}
