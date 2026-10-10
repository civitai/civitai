/**
 * App Blocks CUSTOM EVENTS — the manifest-declared `analytics.events` contract.
 * Pure constants + one pure parser, client-safe: the manifest validator imports
 * it, and so does anything that later needs an app's declared events.
 *
 * An app declares, in its reviewed manifest, every event it may send and every
 * property each event may carry. A property is an `enum` of declared string
 * values, a `number` or a `boolean`. There is deliberately NO free-text string
 * type: whatever a block sends is checked against this declaration, so a value
 * that is not one of the declared strings cannot be recorded at all. That is
 * what stops an app from logging a prompt, an email or a username through this
 * channel, and it also bounds how many distinct values can ever be stored.
 *
 * Every bound below is mirrored in `public/schemas/app-block/v1.json` (the
 * published manifest schema); a drift-guard test pins the two together.
 */

/**
 * Event names and property names share one rule: lowercase snake_case starting
 * with a letter, at most 64 characters. The length IS in the regex here because
 * the published schema expresses it the same way (`propertyNames.pattern`), and
 * the drift guard asserts the schema pattern equals this regex's `source` — one
 * spelling, so the two cannot disagree about a 65-character name.
 */
export const BLOCK_ANALYTICS_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** Most events one manifest may declare. */
export const BLOCK_ANALYTICS_MAX_EVENTS = 50;
/** Most properties one event may declare. */
export const BLOCK_ANALYTICS_MAX_PROPERTIES = 10;
/** Most values one `enum` property may declare. */
export const BLOCK_ANALYTICS_MAX_ENUM_VALUES = 50;
/** Longest single `enum` value, in characters. */
export const BLOCK_ANALYTICS_ENUM_VALUE_MAX_LENGTH = 64;
/** Longest event `description`, in characters (raw, not trimmed). */
export const BLOCK_ANALYTICS_DESCRIPTION_MAX_LENGTH = 200;

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
 * `BLOCK_ANALYTICS_NAME_RE`, which admits `constructor`, `valueof` and friends.
 * On a plain object, a lookup of an UNDECLARED name such as `constructor` returns
 * `Object.prototype.constructor` — truthy — so a declared-event check written as
 * `events[name]` would accept it. A `Map` only answers for keys that were set.
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

/** A name as it appears in an error: quoted, and bounded so a huge key cannot bloat the message. */
function quoteName(name: string): string {
  return JSON.stringify(name.length > 80 ? `${name.slice(0, 80)}…` : name);
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
  let ok = true;
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.includes(key)) {
      errors.push(`${at}.${key} is not allowed on a ${type} property`);
      ok = false;
    }
  }

  if (type === 'number' || type === 'boolean') return ok ? { type } : null;

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
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > BLOCK_ANALYTICS_ENUM_VALUE_MAX_LENGTH
    ) {
      errors.push(
        `${at}.values[${index}] must be a non-empty string of at most ${BLOCK_ANALYTICS_ENUM_VALUE_MAX_LENGTH} characters`
      );
      ok = false;
      return;
    }
    if (seen.has(value)) {
      errors.push(`${at}.values[${index}] duplicates an earlier value (${quoteName(value)})`);
      ok = false;
      return;
    }
    seen.add(value);
  });
  return ok ? { type: 'enum', values: [...seen] } : null;
}

function parseEvent(at: string, raw: unknown, errors: string[]): DeclaredEvent | null {
  if (!isPlainObject(raw)) {
    errors.push(`${at} must be an object`);
    return null;
  }
  let ok = true;
  for (const key of Object.keys(raw)) {
    if (!EVENT_KEYS.has(key)) {
      errors.push(`${at}.${key} is not allowed (an event takes only description and properties)`);
      ok = false;
    }
  }

  const { description } = raw;
  if (
    description !== undefined &&
    (typeof description !== 'string' || description.length > BLOCK_ANALYTICS_DESCRIPTION_MAX_LENGTH)
  ) {
    errors.push(
      `${at}.description must be a string of at most ${BLOCK_ANALYTICS_DESCRIPTION_MAX_LENGTH} characters`
    );
    ok = false;
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
        ok = false;
        continue;
      }
      const prop = parseProperty(`${at}.properties.${name}`, rawProps[name], errors);
      if (prop) properties.set(name, prop);
      else ok = false;
    }
  }

  if (!ok) return null;
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
      errors.push(`analytics.${key} is not allowed (analytics takes only events)`);
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
 *   `analytics` key is valid and declares nothing — every app that exists today
 *   is in that state.
 * - **Strips, never repairs.** An event whose declaration has ANY error is left
 *   out of `events` entirely (with every error it produced reported), rather than
 *   kept with its bad parts removed: a half-declared event is not what a reviewer
 *   approved. Too many events, or too many properties on one event, drops the
 *   whole catalog or the whole event respectively.
 * - **Normalised.** `events` holds only the keys this contract defines, enum
 *   values in declaration order, and `Map`s rather than plain objects (see
 *   `DeclaredEvents`).
 * - **Cheap.** One pass over at most 50 × 10 × 50 entries, no I/O.
 */
export function parseManifestAnalytics(manifest: unknown): ParsedManifestAnalytics {
  try {
    return parse(manifest);
  } catch {
    // Only reachable through exotic input (a throwing getter or a Proxy); a
    // manifest parsed from JSON cannot get here. Totality is the contract.
    return { events: new Map(), errors: ['analytics could not be read'] };
  }
}
