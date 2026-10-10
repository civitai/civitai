/**
 * App Blocks CUSTOM EVENTS — the manifest-declared `analytics.events` contract.
 * Pure and client-safe: no server imports (the manifest validator that imports
 * it is client-bundle-safe).
 *
 * An app declares, in its reviewed manifest, every event it may send and every
 * property each event may carry. A property is an `enum` of declared string
 * values, a `number` or a `boolean`. There is deliberately NO free-text string
 * type: an enum admits only its declared strings, so a prompt, an email or a
 * username has no string property to travel in. (A `number` property is
 * unbounded, so this guard is about strings only.)
 *
 * Every bound below is mirrored in `public/schemas/app-block/v1.json` (the
 * published manifest schema); a drift-guard test pins the two together. Lengths
 * are counted in Unicode CODE POINTS, as JSON Schema `maxLength` counts them —
 * not in UTF-16 units (`String#length`), which would reject an emoji string the
 * published schema accepts.
 */

/**
 * Shared by event and property names. The length lives in the regex because the
 * schema's `propertyNames.pattern` must equal its `.source` (drift-guarded).
 */
export const BLOCK_ANALYTICS_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** Most events one manifest may declare. */
export const BLOCK_ANALYTICS_MAX_EVENTS = 50;
/** Most properties one event may declare. */
export const BLOCK_ANALYTICS_MAX_PROPERTIES = 10;
/** Most values one `enum` property may declare. */
export const BLOCK_ANALYTICS_MAX_ENUM_VALUES = 50;
/** Longest single `enum` value, in code points. */
export const BLOCK_ANALYTICS_ENUM_VALUE_MAX_LENGTH = 64;
/** Longest event `description`, in code points (raw, not trimmed). */
export const BLOCK_ANALYTICS_DESCRIPTION_MAX_LENGTH = 200;

/**
 * Most errors one parse reports; the rest are summarised in one final line. The
 * errors are joined into the submit response, so without a cap a crafted
 * manifest can turn into a multi-megabyte error message.
 */
export const BLOCK_ANALYTICS_MAX_ERRORS = 20;

export const BLOCK_ANALYTICS_PROPERTY_TYPES = ['enum', 'number', 'boolean'] as const;
export type BlockAnalyticsPropertyType = (typeof BLOCK_ANALYTICS_PROPERTY_TYPES)[number];

export type DeclaredEventProperty =
  | { type: 'enum'; values: readonly string[] }
  | { type: 'number' }
  | { type: 'boolean' };

export type DeclaredEvent = {
  description?: string;
  properties: ReadonlyMap<string, DeclaredEventProperty>;
};

/**
 * Event name → declaration.
 *
 * 🔴 A `Map`, NOT A PLAIN OBJECT. Names are author-chosen and only have to match
 * `BLOCK_ANALYTICS_NAME_RE`, which admits `constructor`. On a plain object, a
 * lookup of an UNDECLARED `constructor` returns `Object.prototype.constructor` —
 * truthy — so a declared-event check written as `events[name]` would accept it.
 * A `Map` only answers for keys that were set.
 */
export type DeclaredEvents = ReadonlyMap<string, DeclaredEvent>;

export type ParsedManifestAnalytics = {
  events: DeclaredEvents;
  errors: string[];
};

const EVENT_KEYS = new Set(['description', 'properties']);
const ANALYTICS_KEYS = new Set(['events']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True when `value` has more than `max` code points. `String#length` counts UTF-16
 * units, which is at least the code-point count and at most twice it, so only the
 * band in between needs the (allocating) exact count.
 */
function exceedsCodePoints(value: string, max: number): boolean {
  if (value.length <= max) return false;
  if (value.length > max * 2) return true;
  return [...value].length > max;
}

/** A key as it appears in an error, bounded so a huge key cannot bloat the message. */
function boundKey(key: string): string {
  return key.length > 80 ? `${key.slice(0, 80)}…` : key;
}

/** A name as it appears in an error: quoted and bounded. */
function quoteName(name: string): string {
  return JSON.stringify(boundKey(name));
}

function parseProperty(at: string, raw: unknown, errors: string[]): DeclaredEventProperty | null {
  if (!isPlainObject(raw)) {
    errors.push(`${at} must be an object`);
    return null;
  }
  const { type } = raw;
  if (
    typeof type !== 'string' ||
    !(BLOCK_ANALYTICS_PROPERTY_TYPES as readonly string[]).includes(type)
  ) {
    errors.push(
      `${at}.type must be one of ${BLOCK_ANALYTICS_PROPERTY_TYPES.join(
        ', '
      )} (free-text strings are not allowed — declare an enum)`
    );
    return null;
  }

  const allowedKeys = type === 'enum' ? ['type', 'values'] : ['type'];
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.includes(key)) {
      errors.push(`${at}.${boundKey(key)} is not allowed on a ${type} property`);
    }
  }

  if (type === 'number' || type === 'boolean') return { type };

  const { values } = raw;
  if (!Array.isArray(values)) {
    errors.push(`${at}.values must be an array of strings`);
    return null;
  }
  if (values.length === 0 || values.length > BLOCK_ANALYTICS_MAX_ENUM_VALUES) {
    errors.push(
      `${at}.values must declare between 1 and ${BLOCK_ANALYTICS_MAX_ENUM_VALUES} values`
    );
    return null;
  }
  // At most ONE error per property: the first bad value. Reporting every bad
  // value multiplies a single mistake by up to 50.
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      exceedsCodePoints(value, BLOCK_ANALYTICS_ENUM_VALUE_MAX_LENGTH)
    ) {
      errors.push(
        `${at}.values[${index}] must be a non-empty string of at most ${BLOCK_ANALYTICS_ENUM_VALUE_MAX_LENGTH} characters`
      );
      return null;
    }
    if (seen.has(value)) {
      errors.push(`${at}.values[${index}] duplicates an earlier value (${quoteName(value)})`);
      return null;
    }
    seen.add(value);
  }
  return { type: 'enum', values: [...seen] };
}

function parseEvent(at: string, raw: unknown, errors: string[]): DeclaredEvent | null {
  if (!isPlainObject(raw)) {
    errors.push(`${at} must be an object`);
    return null;
  }
  for (const key of Object.keys(raw)) {
    if (!EVENT_KEYS.has(key)) {
      errors.push(
        `${at}.${boundKey(key)} is not allowed (an event takes only description and properties)`
      );
    }
  }

  const { description } = raw;
  if (
    description !== undefined &&
    (typeof description !== 'string' ||
      exceedsCodePoints(description, BLOCK_ANALYTICS_DESCRIPTION_MAX_LENGTH))
  ) {
    errors.push(
      `${at}.description must be a string of at most ${BLOCK_ANALYTICS_DESCRIPTION_MAX_LENGTH} characters`
    );
  }

  const properties = new Map<string, DeclaredEventProperty>();
  const rawProps = raw.properties;
  if (rawProps !== undefined) {
    if (!isPlainObject(rawProps)) {
      errors.push(`${at}.properties must be an object mapping property name to declaration`);
      return null;
    }
    const names = Object.keys(rawProps);
    if (names.length > BLOCK_ANALYTICS_MAX_PROPERTIES) {
      errors.push(
        `${at}.properties may declare at most ${BLOCK_ANALYTICS_MAX_PROPERTIES} properties (found ${names.length})`
      );
      return null;
    }
    for (const name of names) {
      if (!BLOCK_ANALYTICS_NAME_RE.test(name)) {
        errors.push(
          `${at}.properties key ${quoteName(
            name
          )} must be lowercase snake_case: a letter, then up to 63 of a-z, 0-9 or _`
        );
        continue;
      }
      const prop = parseProperty(`${at}.properties.${name}`, rawProps[name], errors);
      if (prop) properties.set(name, prop);
    }
  }

  return typeof description === 'string' ? { description, properties } : { properties };
}

function parse(manifest: unknown): ParsedManifestAnalytics {
  const events = new Map<string, DeclaredEvent>();
  if (!isPlainObject(manifest)) return { events, errors: [] };
  const analytics = manifest.analytics;
  if (analytics === undefined) return { events, errors: [] };
  if (!isPlainObject(analytics)) return { events, errors: ['analytics must be an object'] };

  const errors: string[] = [];
  for (const key of Object.keys(analytics)) {
    if (!ANALYTICS_KEYS.has(key)) {
      errors.push(`analytics.${boundKey(key)} is not allowed (analytics takes only events)`);
    }
  }

  const rawEvents = analytics.events;
  if (rawEvents === undefined) return { events, errors };
  if (!isPlainObject(rawEvents)) {
    errors.push('analytics.events must be an object mapping event name to declaration');
    return { events, errors };
  }
  const names = Object.keys(rawEvents);
  if (names.length > BLOCK_ANALYTICS_MAX_EVENTS) {
    errors.push(
      `analytics.events may declare at most ${BLOCK_ANALYTICS_MAX_EVENTS} events (found ${names.length})`
    );
    return { events, errors };
  }

  for (const name of names) {
    if (!BLOCK_ANALYTICS_NAME_RE.test(name)) {
      errors.push(
        `analytics.events key ${quoteName(
          name
        )} must be lowercase snake_case: a letter, then up to 63 of a-z, 0-9 or _`
      );
      continue;
    }
    const event = parseEvent(`analytics.events.${name}`, rawEvents[name], errors);
    if (event) events.set(name, event);
  }
  return { events, errors };
}

/**
 * THE `analytics.events` parser. The submit-time manifest validator reads its
 * `errors`; a consumer that needs the declaration reads `events`.
 *
 * - **Total.** Never throws, whatever it is handed. A manifest with no
 *   `analytics` key is valid and declares nothing.
 * - **All or nothing.** If there is ANY error, `events` is empty: a declaration
 *   that does not validate declares nothing, so no reader can act on part of one.
 * - **Bounded errors.** At most {@link BLOCK_ANALYTICS_MAX_ERRORS} messages plus
 *   one summary line, at most one per enum property, keys truncated.
 * - **Normalised.** `events` holds only the keys this contract defines, enum
 *   values in declaration order, and `Map`s rather than plain objects (see
 *   `DeclaredEvents`).
 * - **No I/O.** One pass over the declaration; a later consumer can call it
 *   from a cache.
 */
export function parseManifestAnalytics(manifest: unknown): ParsedManifestAnalytics {
  try {
    const { events, errors } = parse(manifest);
    if (errors.length === 0) return { events, errors };
    const capped = errors.slice(0, BLOCK_ANALYTICS_MAX_ERRORS);
    const rest = errors.length - capped.length;
    if (rest > 0) capped.push(`…and ${rest} more analytics errors`);
    return { events: new Map(), errors: capped };
  } catch {
    // Reachable only via a throwing getter or Proxy; JSON input cannot get here.
    return { events: new Map(), errors: ['analytics could not be read'] };
  }
}
