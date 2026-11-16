import type { ValidateFunction } from 'ajv';
import Ajv2020 from 'ajv/dist/2020';
import type { FilterRegExpEngine } from '~/server/registry-adapter/filter-pattern';
import {
  FILTER_PATTERN_MAX_SIZE,
  FilterPatternError,
  filterRegExpEngine,
} from '~/server/registry-adapter/filter-pattern';
import type { JsonSchema } from '~/server/registry-adapter/protocol';
import { ProtocolError } from '~/server/registry-adapter/protocol';

/**
 * A JSON Schema 2020-12 validator. `format` is an annotation here, as 2020-12 makes it by
 * default; unknown keywords (such as `x-migrateFrom`) are ignored rather than refused.
 */
export function newValidator() {
  return new Ajv2020({ strict: false, validateFormats: false, allErrors: false });
}

/**
 * Most places a filter may apply a pattern: each `pattern`, each `patternProperties` key, and
 * each such key again where `additionalProperties` re-tests it, a pattern repeated counted every
 * time. A pattern runs on re2js's DFA where its states fit the DFA's memory, and otherwise
 * rebuilds the DFA and falls back to its NFA, so a place whose input keeps the DFA from fitting
 * costs tens of milliseconds whatever its size: the number of places, more than their size, sets
 * the worst case.
 *
 * Measured through ajv against random `a`/`b` text (which keeps the DFA from fitting), best of 3,
 * `^x` 0 ms throughout: `[ab]{0,125}b[ab]{125}c` (size 253), the worst shape found, ~130 ms in one
 * place and ~250-270 ms in two (the same pattern twice or two variants) per 20 000 characters,
 * ~0.7 s and ~1.3 s per 200 000; smaller sizes of that shape cost less. With 8 places allowed, 8
 * places of ~61 took ~610 ms per 20 000.
 *
 * Distinct patterns are at most the places, so this also bounds the compiled patterns a filter
 * keeps, each with a DFA re2js lets grow to ~8 MB as bodies are matched (measured: ~8.7 MB of
 * heap for `.{0,1000}[xy]` after one 20 000-character match, ~4 MB for the 23-sized
 * `[ab]*a[ab]{20}$`).
 */
export const FILTER_MAX_PATTERN_PLACES = 2;

/**
 * Largest total size of a filter's patterns, each counted once per place it is applied and as
 * {@link FILTER_PATTERN_MAX_SIZE} counts it: two patterns of the largest size. With
 * {@link FILTER_MAX_PATTERN_PLACES} at 2 this bound follows from the other two and never refuses
 * on its own; it is kept so that raising the place bound does not lift the total with it.
 */
export const FILTER_PATTERNS_MAX_TOTAL_SIZE = 2 * FILTER_PATTERN_MAX_SIZE;

/**
 * {@link newValidator} for a request filter: its `pattern` and `patternProperties` run on a
 * linear-time engine (`filter-pattern.ts`), since a filter's patterns are the consumer's. The
 * other validators keep the platform RegExp: their schemas are this source's own. With `strict`
 * off ajv never runs a pattern at compile time either (its `allowMatchingProperties` check, the
 * one place it calls `new RegExp` directly, is a strict-mode check).
 */
function newFilterValidator(regExp: FilterRegExpEngine) {
  return new Ajv2020({
    strict: false,
    validateFormats: false,
    allErrors: false,
    code: { regExp },
  });
}

/** Largest request filter this source will compile, as JSON. */
export const FILTER_MAX_BYTES = 8 * 1024;

/** Deepest object/array nesting a filter may have, so compiling it never recurses deeply. */
export const FILTER_MAX_DEPTH = 32;

/**
 * Keys that make a filter's evaluation cost unbounded by its size, refused wherever they appear:
 * `$ref`, `$dynamicRef`, `$recursiveRef`, `$defs`, `definitions`. A reference lets a small filter
 * reuse a subschema, so definitions that each hold two references to the next form a DAG whose
 * evaluation doubles at every level. Without them every subschema is evaluated once per value it
 * applies to, so the work outside patterns is bounded by the filter's size times the body's.
 *
 * `pattern` and `patternProperties` are applied, not refused: they run on a linear-time engine
 * (`filter-pattern.ts`), whose cost per character grows with the pattern's size (its counted
 * repetitions multiplied out), not its length, plus a cost per place the pattern is applied when
 * the input keeps its DFA from fitting. So a pattern's size is bounded
 * ({@link FILTER_PATTERN_MAX_SIZE}), and so are the places a filter applies one
 * ({@link FILTER_MAX_PATTERN_PLACES}) and their sizes' sum ({@link FILTER_PATTERNS_MAX_TOTAL_SIZE});
 * the pattern work per body is then a few hundred milliseconds per 20 000 characters of string
 * at worst (measured at {@link FILTER_MAX_PATTERN_PLACES}). A pattern it cannot run
 * with ECMA-262's meaning (a lookaround, a backreference), one over its length or size bound, or a
 * filter over {@link FILTER_MAX_PATTERN_PLACES} or the total, is `bad_request` when it is compiled.
 */
const REFUSED_FILTER_KEYS = [
  '$ref',
  '$dynamicRef',
  '$recursiveRef',
  '$defs',
  'definitions',
] as const;

/**
 * Keywords whose value is data, never a schema: ajv compares against it (`const`, `enum`) or
 * ignores it (`default`, `examples`), and evaluates nothing inside it. A filter matching a whole
 * body, `{"const": <body>}`, holds the body's own keys there, `$ref` or `$defs` among them.
 */
const DATA_KEYWORDS: ReadonlySet<string> = new Set(['const', 'enum', 'default', 'examples']);

/**
 * Keywords whose value is a map from a NAME (a property, a definition) to a schema. A key of that
 * map is a name, not a keyword: a property named `const` holds a schema, so it is walked.
 */
const NAME_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  'properties',
  'patternProperties',
  'dependentSchemas',
  'dependencies',
  '$defs',
  'definitions',
]);

/**
 * Why this source refuses to evaluate `filter`, or null when it does not: a
 * {@link REFUSED_FILTER_KEYS} key in any object of its JSON, whatever the key above it, except
 * inside the value of a {@link DATA_KEYWORDS} keyword (data ajv evaluates nothing in) — or nesting
 * deeper than {@link FILTER_MAX_DEPTH}. A refused construct reaches ajv through more than the
 * schema keywords one would list (`dependencies`, a member of the document), so everything but
 * data is walked. A data keyword is skipped only where it IS a keyword: under a
 * {@link NAME_MAP_KEYWORDS} map the same key is a name whose value is a schema, and is walked. It
 * can still refuse a harmless filter (a property that happens to be named `$ref`). A refused
 * filter is answered `bad_request` ({@link createFilterCompiler}): the spec's rule 6 lets a
 * registry decline a filter that way, never ignore it, since a consumer would take what it got
 * for filtered.
 *
 * ajv validation is synchronous and runs per entity, per poll, on the one event loop that serves
 * every stream, so a costly filter would stall every consumer, not just its sender. The work
 * outside patterns is bounded by the filter's size times the body's; pattern work by
 * {@link FILTER_MAX_PATTERN_PLACES} places of at most {@link FILTER_PATTERN_MAX_SIZE} each, run over
 * the body's strings.
 */
export function filterRefusal(filter: unknown): string | null {
  // `names`: the node is a NAME_MAP_KEYWORDS map, whose keys are names rather than keywords.
  const stack: Array<{ node: unknown; depth: number; names: boolean }> = [
    { node: filter, depth: 0, names: false },
  ];
  while (stack.length > 0) {
    const { node, depth, names } = stack.pop()!;
    if (!node || typeof node !== 'object') continue;
    if (depth > FILTER_MAX_DEPTH) {
      return `filter nests deeper than ${FILTER_MAX_DEPTH} levels, which this registry does not apply`;
    }
    if (Array.isArray(node)) {
      for (const child of node) stack.push({ node: child, depth: depth + 1, names: false });
      continue;
    }
    const record = node as Record<string, unknown>;
    const key = REFUSED_FILTER_KEYS.find((k) => Object.hasOwn(record, k));
    if (key !== undefined) {
      return (
        `filter uses "${key}", which this registry does not apply ` +
        `(it refuses ${REFUSED_FILTER_KEYS.join(', ')} anywhere in a filter)`
      );
    }
    for (const [k, child] of Object.entries(record)) {
      if (!names && DATA_KEYWORDS.has(k)) continue;
      stack.push({ node: child, depth: depth + 1, names: !names && NAME_MAP_KEYWORDS.has(k) });
    }
  }
  return null;
}

/**
 * A request's `filter` as a predicate over bodies; `undefined` when there is none. A filter this
 * source will not evaluate — longer than {@link FILTER_MAX_BYTES} as JSON, one
 * {@link filterRefusal} refuses, or one with a pattern the linear-time engine refuses
 * ({@link FilterPatternError}) — is `bad_request`, as is one that is not a JSON Schema: a
 * registry that accepts a filter applies it in full, and never ignores one (spec rule 6).
 *
 * Compiled filters are cached by their text, at most `maxCached` of them holding at most
 * `maxCachedPatterns` patterns in all (the cache is emptied when either is full), so many distinct
 * filters cost compile time, never unbounded memory: a cached pattern can keep ~8 MB of DFA
 * ({@link FILTER_MAX_PATTERN_PLACES}), so the patterns, not the filters, are what the cache must
 * count. A filter holds at most 2 patterns, so 100 filters could otherwise hold 200 (~1.7 GB at
 * the worst measured); 16 bounds it to ~140 MB.
 */
export type BodyPredicate = (body: unknown) => boolean;

export function createFilterCompiler(maxCached = 100, maxCachedPatterns = 16) {
  const cache = new Map<string, BodyPredicate>();
  let cachedPatterns = 0;
  return (filter: JsonSchema | undefined): BodyPredicate | undefined => {
    if (filter === undefined) return undefined;
    const text = JSON.stringify(filter);
    if (text.length > FILTER_MAX_BYTES) {
      throw new ProtocolError(
        'bad_request',
        `filter is longer than ${FILTER_MAX_BYTES} characters as JSON, which this registry does not apply`
      );
    }
    const refusal = filterRefusal(filter);
    if (refusal !== null) throw new ProtocolError('bad_request', refusal);
    const hit = cache.get(text);
    if (hit) return hit;
    let validate: ValidateFunction;
    const regExp = filterRegExpEngine({
      maxTotalSize: FILTER_PATTERNS_MAX_TOTAL_SIZE,
      maxPlaces: FILTER_MAX_PATTERN_PLACES,
    });
    try {
      const ajv = newFilterValidator(regExp);
      // ajv's meta-schema has patterns of its own, compiled through `regExp` the first time a
      // schema is validated; they are compiled now, before the engine counts the filter's.
      ajv.validateSchema({});
      regExp.arm();
      // Each pattern is compiled here, once per distinct pattern, never per entity.
      validate = ajv.compile(filter);
    } catch (err) {
      if (err instanceof FilterPatternError) throw new ProtocolError('bad_request', err.message);
      throw new ProtocolError('bad_request', 'filter is not a valid JSON Schema');
    }
    const predicate = (body: unknown) => validate(body) === true;
    const patterns = regExp.distinct();
    if (cache.size >= maxCached || cachedPatterns + patterns > maxCachedPatterns) {
      cache.clear();
      cachedPatterns = 0;
    }
    cache.set(text, predicate);
    cachedPatterns += patterns;
    return predicate;
  };
}
