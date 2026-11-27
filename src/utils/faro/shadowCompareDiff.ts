/**
 * Where two JSON response texts first differ, as a path of keys and indices: `$.result.data.json
 * .items[3].id`. Never a value. Runs only after the hashes disagreed, and is bounded so a large or
 * deeply nested response cannot hold the main thread. Two devalue answers are compared by their
 * decoded values (`devalueAnswerDiff`).
 */

import { parse as devalueParse } from 'devalue';

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
  /**
   * Structurally equal JSON whose texts still differ (whitespace, number or string escaping). `-0`
   * against `0` is a `value`: the client decodes the two apart.
   */
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

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * A tRPC answer's text without superjson's `meta.referentialEqualities` (at
 * `$.result.data.meta.referentialEqualities`), or `undefined` when there is nothing to remove or
 * the text cannot be rewritten without changing anything else.
 *
 * The Node writer adds that member when one object instance appears at several paths (a creator's
 * `cosmetics` shared by all their images). For a shared, non-circular object, which is what these
 * feeds' database rows produce, it changes object identity after decode, never a decoded value, and
 * the Go service deliberately never writes it (apps/feed-go/internal/superjson). A CIRCULAR
 * reference is different: superjson writes `null` at the back-reference and restores the cycle from
 * this member, so there it does carry a value. Revisit this if a shadowed procedure ever returns one.
 *
 * When `v` is all that is left of `meta`, `meta` goes too: that is what superjson writes when there
 * is nothing to annotate, and what the Go service writes for the same value.
 *
 * The rewrite is `JSON.stringify` of the parsed text, so it applies only to a text that is already
 * exactly `JSON.stringify` output (as the Node writer's is). Any other text is left alone, so its
 * encoding is still compared byte for byte.
 */
export function withoutReferentialEqualities(text: string): string | undefined {
  if (text.length > SHADOW_DIFF_BUDGET.maxTextLength) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed)) return undefined;
  const result = parsed.result;
  if (!isPlainObject(result)) return undefined;
  const data = result.data;
  if (!isPlainObject(data)) return undefined;
  const meta = data.meta;
  if (!isPlainObject(meta) || !hasOwn(meta, 'referentialEqualities')) return undefined;
  if (JSON.stringify(parsed) !== text) return undefined;

  delete meta.referentialEqualities;
  const rest = Object.keys(meta);
  if (rest.length === 1 && rest[0] === 'v') delete data.meta;
  return JSON.stringify(parsed);
}

function keySegment(key: string): string {
  return REPORTABLE_KEYS.has(key) ? `.${key}` : '.*';
}

/**
 * A value's type for the walk: the JSON types, plus what a devalue body can decode to (undefined,
 * bigint, Date, RegExp, Map, Set) and any other object reported by its kind, never compared by
 * reference.
 */
type ValueType =
  | 'null'
  | 'undefined'
  | 'array'
  | 'object'
  | 'string'
  | 'number'
  | 'boolean'
  | 'bigint'
  | 'date'
  | 'regexp'
  | 'map'
  | 'set'
  | 'other';

function valueType(value: unknown): ValueType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  if (value instanceof RegExp) return 'regexp';
  if (value instanceof Map) return 'map';
  if (value instanceof Set) return 'set';
  const t = typeof value;
  if (t === 'object') {
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null ? 'object' : 'other';
  }
  if (t === 'undefined' || t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint')
    return t;
  return 'other';
}

/** A value of no type above (a typed array, a URL), compared by its tag and its string form. */
function sameOther(a: unknown, b: unknown): boolean {
  const tag = Object.prototype.toString;
  return tag.call(a) === tag.call(b) && String(a) === String(b);
}

class BudgetSpent {
  constructor(readonly path: string) {}
}

/**
 * The first place two values differ, walked in the control's order, or `null` when they are equal.
 * Throws `BudgetSpent` past the depth or node budget. A pair of objects already being compared is
 * not walked again, so a decoded value whose objects are shared, or circular, costs one visit per
 * pair; object identity itself is not compared (two bodies that share an object or repeat it decode
 * to the same value).
 */
function firstValueDiff(
  control: unknown,
  candidate: unknown,
  root: string,
  budget: ShadowDiffBudget
): ShadowDiff | null {
  let nodes = 0;
  const seen = new Map<object, Set<object>>();
  const walk = (a: unknown, b: unknown, path: string, depth: number): ShadowDiff | null => {
    nodes += 1;
    if (nodes > budget.maxNodes || depth > budget.maxDepth) throw new BudgetSpent(path);
    const typeA = valueType(a);
    if (typeA !== valueType(b)) return { path, kind: 'type' };
    if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
      const pairs = seen.get(a);
      if (pairs?.has(b)) return null;
      if (pairs) pairs.add(b);
      else seen.set(a, new Set([b]));
    }
    const walkList = (listA: unknown[], listB: unknown[]): ShadowDiff | null => {
      const shared = Math.min(listA.length, listB.length);
      for (let i = 0; i < shared; i++) {
        const found = walk(listA[i], listB[i], `${path}[${i}]`, depth + 1);
        if (found) return found;
      }
      if (listA.length > shared)
        return { path: `${path}[${shared}]`, kind: 'missing_in_candidate' };
      if (listB.length > shared) return { path: `${path}[${shared}]`, kind: 'extra_in_candidate' };
      return null;
    };
    switch (typeA) {
      case 'array':
        return walkList(a as unknown[], b as unknown[]);
      // A Map as its [key, value] entries and a Set as its members, in insertion order.
      case 'map':
        return walkList(
          Array.from((a as Map<unknown, unknown>).entries()),
          Array.from((b as Map<unknown, unknown>).entries())
        );
      case 'set':
        return walkList(Array.from(a as Set<unknown>), Array.from(b as Set<unknown>));
      case 'date':
        return Object.is((a as Date).getTime(), (b as Date).getTime())
          ? null
          : { path, kind: 'value' };
      case 'regexp':
        return String(a) === String(b) ? null : { path, kind: 'value' };
      case 'other':
        return sameOther(a, b) ? null : { path, kind: 'value' };
      case 'object': {
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
      default:
        // Object.is: NaN equals NaN, and -0 is not 0 (devalue keeps both apart).
        return Object.is(a, b) ? null : { path, kind: 'value' };
    }
  };
  return walk(control, candidate, root, 0);
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

  try {
    return firstValueDiff(control, candidate, '$', budget) ?? { path: '$', kind: 'encoding' };
  } catch (error) {
    if (error instanceof BudgetSpent) return { path: error.path, kind: 'budget' };
    throw error;
  }
}

/** Where a devalue answer's value sits in the tRPC envelope. */
const DEVALUE_DATA_PATH = '$.result.data';
const DEVALUE_ENVELOPE_PREFIX = '{"result":{"data":"';

/**
 * The devalue string of a tRPC answer, when the text is exactly `{"result":{"data":"<string>"}}`
 * (what the Node and Go writers send for an answer that is not edge-cacheable); otherwise
 * `undefined`. A superjson answer's `data` is an object, so it is never one.
 */
function devalueData(text: string, budget: ShadowDiffBudget): string | undefined {
  // The writers' envelope is JSON.stringify's: a superjson answer is turned away without a parse.
  if (text.length > budget.maxTextLength || !text.startsWith(DEVALUE_ENVELOPE_PREFIX))
    return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed) || Object.keys(parsed).length !== 1) return undefined;
  const result = parsed.result;
  if (!isPlainObject(result) || Object.keys(result).length !== 1) return undefined;
  return typeof result.data === 'string' ? result.data : undefined;
}

/**
 * For two devalue answers, where their DECODED values first differ (`null`: the same value), or
 * `undefined` when either text is not a devalue answer (compare those as text).
 *
 * Both legs' `result.data` is one string, so a text walk can only say "differs at
 * `$.result.data`". Each is decoded with `devalue.parse`, the decoder the client's tRPC
 * transformer applies to the same answer (`unionDeserialize`, src/shared/utils/
 * trpc-union-transformer.ts), and the values are walked from `$.result.data`. The bytes of two
 * devalue bodies of one value can differ (the order of its entries, whether an object or a repeated
 * primitive is shared by reference), and the client cannot see that, so equal values are a match.
 * Key order is part of the decoded value (the client iterates it), so it is still reported. A body
 * that does not decode is `unparseable` at `$.result.data`; the walk keeps the depth and node budget.
 */
export function devalueAnswerDiff(
  controlText: string,
  candidateText: string,
  budget: ShadowDiffBudget = SHADOW_DIFF_BUDGET
): ShadowDiff | null | undefined {
  const controlData = devalueData(controlText, budget);
  const candidateData = devalueData(candidateText, budget);
  if (controlData === undefined || candidateData === undefined) return undefined;
  let control: unknown;
  let candidate: unknown;
  try {
    control = devalueParse(controlData);
    candidate = devalueParse(candidateData);
  } catch {
    return { path: DEVALUE_DATA_PATH, kind: 'unparseable' };
  }
  try {
    return firstValueDiff(control, candidate, DEVALUE_DATA_PATH, budget);
  } catch (error) {
    if (error instanceof BudgetSpent) return { path: error.path, kind: 'budget' };
    throw error;
  }
}
