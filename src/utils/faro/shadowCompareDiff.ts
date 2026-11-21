/**
 * Where two JSON response texts first differ, as a path of keys and indices: `$.result.data.json
 * .items[3].id`. Never a value. Runs only after the hashes disagreed, and is bounded so a large or
 * deeply nested response cannot hold the main thread.
 */

export type ShadowDiffKind =
  /** Same type at the path, different scalar value. */
  | 'value'
  /** Different JSON types at the path (e.g. number vs string, object vs null). */
  | 'type'
  /** The control has this key or index, the candidate does not. */
  | 'missing_in_candidate'
  /** The candidate has this key or index, the control does not. */
  | 'extra_in_candidate'
  /** Same keys and values at the path, in a different order. */
  | 'key_order'
  /** Structurally equal JSON whose texts still differ (whitespace, number or string escaping). */
  | 'encoding'
  /** One of the texts is not JSON. */
  | 'unparseable'
  /** The walk stopped at its depth, node or size budget; the path is where it stopped. */
  | 'budget';

export type ShadowDiff = { path: string; kind: ShadowDiffKind };

export type ShadowDiffBudget = {
  /** Deepest nesting walked; deeper is reported as `budget` at the path reached. */
  maxDepth: number;
  /** Most JSON nodes visited (both sides together count once per pair). */
  maxNodes: number;
  /** Longest text parsed at all, in UTF-16 code units. */
  maxTextLength: number;
};

export const SHADOW_DIFF_BUDGET: ShadowDiffBudget = {
  maxDepth: 32,
  maxNodes: 20_000,
  maxTextLength: 2_000_000,
};

/**
 * The only keys `diff_path` spells out; every other key is reported as `*`, so a key a user chose (a
 * generation-meta key, a map keyed by username or tag) never reaches the beacon, whatever its shape.
 *
 * Source: the tRPC/superjson envelope keys, plus every object key in the Node answers recorded in
 * feed-go's golden fixtures for the three shadowed procedures (`apps/feed-go/testdata/golden/`
 * `as-posts`, `infinite` and `model-getall`, generated from transcriptions of the Node code). Their
 * TypeScript output types are inferred from the database selects across many files, so there is no
 * single declaration to copy. A field missing here is reported as `*`, the safe direction. Add a
 * procedure to the shadow allowlist, add its field names here.
 */
export const REPORTABLE_KEYS: ReadonlySet<string> = new Set([
  // tRPC and superjson envelope
  'result',
  'data',
  'json',
  'meta',
  'values',
  'referentialEqualities',
  'v',
  // image.getImagesAsPostsInfinite, image.getInfinite, model.getAll
  'at',
  'automated',
  'availability',
  'baseModel',
  'baseModels',
  'baseModelType',
  'blockedFor',
  'buzz',
  'canGenerate',
  'collectedCount',
  'collectedCountAllTime',
  'collectionItemAddedById',
  'collectionItemStatus',
  'color',
  'commentCount',
  'commentCountAllTime',
  'concrete',
  'cosmetic',
  'cosmeticId',
  'cosmetics',
  'covered',
  'coveredNext',
  'coverImageId',
  'createdAt',
  'crop',
  'cryCountAllTime',
  'deletedAt',
  'description',
  'details',
  'dislikeCountAllTime',
  'downloadCount',
  'downloads',
  'downVotes',
  'duration',
  'earlyAccessDeadline',
  'earlyAccessTimeFrame',
  'equippedToId',
  'equippedToType',
  'event',
  'eventDecoration',
  'flags',
  'generations',
  'hasActivePaidAccess',
  'hash',
  'hashes',
  'hasMeta',
  'hasPositivePrompt',
  'hasSfwFace',
  'heartCountAllTime',
  'height',
  'hiddenMetrics',
  'id',
  'image',
  'imageCount',
  'imageId',
  'images',
  'index',
  'ingestion',
  'items',
  'judgeScore',
  'lastUpvote',
  'lastVersionAt',
  'laughCountAllTime',
  'likeCountAllTime',
  'locked',
  'metadata',
  'minor',
  'mode',
  'model3dId',
  'modelVersionId',
  'modelVersionIds',
  'modelVersionIdsManual',
  'name',
  'needsReview',
  'nextCursor',
  'nsfw',
  'nsfwLevel',
  'offset',
  'on',
  'onSite',
  'pinned',
  'poi',
  'postId',
  'profilePicture',
  'publishedAt',
  'rank',
  'rating',
  'reaction',
  'reactions',
  'recommended',
  'remixOfId',
  'restricted',
  'review',
  'score',
  'sfwCoverImageId',
  'sfwOnly',
  'sortAt',
  'source',
  'sparkle',
  'sponsored',
  'stats',
  'statsUnknown',
  'status',
  'tagIds',
  'tags',
  'thumbnailId',
  'thumbnailUrl',
  'thumbsDownCount',
  'thumbsUpCount',
  'tippedAmountCount',
  'tippedAmountCountAllTime',
  'trainedWords',
  'trainingStatus',
  'type',
  'upVotes',
  'url',
  'user',
  'userData',
  'userId',
  'username',
  'vaeId',
  'version',
  'viewCountAllTime',
  'vote',
  'width',
]);

const hasOwn = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

function keySegment(key: string): string {
  return REPORTABLE_KEYS.has(key) ? `.${key}` : '.*';
}

type JsonType = 'null' | 'array' | 'object' | 'string' | 'number' | 'boolean';

function jsonType(value: unknown): JsonType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value as JsonType;
}

class BudgetSpent {
  constructor(readonly path: string) {}
}

export function firstDiffPath(
  controlText: string,
  candidateText: string,
  budget: ShadowDiffBudget = SHADOW_DIFF_BUDGET
): ShadowDiff {
  if (controlText.length > budget.maxTextLength || candidateText.length > budget.maxTextLength) {
    return { path: '$', kind: 'budget' };
  }
  let control: unknown;
  let candidate: unknown;
  try {
    control = JSON.parse(controlText);
    candidate = JSON.parse(candidateText);
  } catch {
    return { path: '$', kind: 'unparseable' };
  }

  let nodes = 0;
  const walk = (a: unknown, b: unknown, path: string, depth: number): ShadowDiff | null => {
    nodes += 1;
    if (nodes > budget.maxNodes || depth > budget.maxDepth) throw new BudgetSpent(path);
    const typeA = jsonType(a);
    if (typeA !== jsonType(b)) return { path, kind: 'type' };
    if (typeA === 'array') {
      const arrA = a as unknown[];
      const arrB = b as unknown[];
      const shared = Math.min(arrA.length, arrB.length);
      for (let i = 0; i < shared; i++) {
        const found = walk(arrA[i], arrB[i], `${path}[${i}]`, depth + 1);
        if (found) return found;
      }
      if (arrA.length > shared) return { path: `${path}[${shared}]`, kind: 'missing_in_candidate' };
      if (arrB.length > shared) return { path: `${path}[${shared}]`, kind: 'extra_in_candidate' };
      return null;
    }
    if (typeA === 'object') {
      const objA = a as Record<string, unknown>;
      const objB = b as Record<string, unknown>;
      const keysA = Object.keys(objA);
      const keysB = Object.keys(objB);
      for (const key of keysA) {
        const childPath = `${path}${keySegment(key)}`;
        if (!hasOwn(objB, key)) return { path: childPath, kind: 'missing_in_candidate' };
        const found = walk(objA[key], objB[key], childPath, depth + 1);
        if (found) return found;
      }
      for (const key of keysB) {
        if (!hasOwn(objA, key)) {
          return { path: `${path}${keySegment(key)}`, kind: 'extra_in_candidate' };
        }
      }
      // Same key set, so equal length; a different order still changes the bytes.
      for (let i = 0; i < keysA.length; i++) {
        if (keysA[i] !== keysB[i]) return { path, kind: 'key_order' };
      }
      return null;
    }
    return a === b ? null : { path, kind: 'value' };
  };

  try {
    return walk(control, candidate, '$', 0) ?? { path: '$', kind: 'encoding' };
  } catch (error) {
    if (error instanceof BudgetSpent) return { path: error.path, kind: 'budget' };
    throw error;
  }
}
