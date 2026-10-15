import {
  APPS_PLATFORM_FEEDBACK_AREA,
  PLATFORM_FEEDBACK_CLIENT_COMPONENT,
  PLATFORM_FEEDBACK_DOC_URL_PREFIX,
  PLATFORM_FEEDBACK_PUBLIC_NOTE_MAX_LENGTH,
} from '@civitai/shared/feedback.constants';
// Relative, not `$lib`: imported by the main app's moderator-seam test.
import { isPlainObject, isString } from './feedback';

/**
 * `apps-platform` rows: developer-platform feedback a coding agent sends with an API token. The
 * stored `context` is `{ report, server }` — `report` is what the client claimed, `server` is written
 * by the main app's `platform-feedback.service.ts` and, for `resolution` only, by this app.
 *
 * Everything under `report` and `server.samples` is reporter-supplied text: render it as text.
 */

export const isPlatformFeedbackArea = (area: string): boolean =>
  area === APPS_PLATFORM_FEEDBACK_AREA;

/** What a moderator can say a report was fixed in. */
export const PLATFORM_FIXED_IN_COMPONENTS = [
  'cli',
  'mcp',
  'docs',
  'sdk',
  'review',
  'other',
] as const;
export type PlatformFixedInComponent = (typeof PLATFORM_FIXED_IN_COMPONENTS)[number];

/** The components whose fix version the service compares a reporter's client version against. */
export const PLATFORM_REGRESSION_COMPONENTS: readonly PlatformFixedInComponent[] = Object.values(
  PLATFORM_FEEDBACK_CLIENT_COMPONENT
);

/** The service clips the note it reads back to this, so a longer one would be read back cut. */
export const PLATFORM_PUBLIC_NOTE_MAX_LENGTH = PLATFORM_FEEDBACK_PUBLIC_NOTE_MAX_LENGTH;

export const PLATFORM_FIXED_IN_VERSION_MAX_LENGTH = 32;

export type PlatformResolution = {
  fixedIn: { component: string; version: string } | null;
  publicNote: string | null;
  at: string | null;
  byId: number | null;
};

export type PlatformSample = { userId: number | null; text: string; clientVersion: string | null };

export type PlatformFeedbackContext = {
  /** The client's claim, as label/text pairs in a fixed order. `docUrl` is carried by `doc`. */
  report: { key: string; label: string; text: string }[];
  /** `href` is set only for a first-party docs URL; anything else is shown as text. */
  doc: { text: string; href: string | null } | null;
  fingerprint: string | null;
  reporters: number | null;
  reports: number | null;
  /** How many reporter ids the row holds — never the ids themselves. */
  reporterIdCount: number | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  reopenOf: number | null;
  regressionOf: number | null;
  resolution: PlatformResolution | null;
  samples: PlatformSample[];
  /** Everything the named keys did not claim, nested where it was found. `null` when nothing is left. */
  other: Record<string, unknown> | null;
};

const REPORT_TEXT_FIELDS = {
  about: 'About',
  kind: 'Kind',
  ref: 'Failure site',
  agent: 'Agent',
  os: 'OS',
  arch: 'Arch',
  command: 'Command',
  errorExcerpt: 'Error excerpt',
  appSlug: 'App',
} as const;

const REPORT_NUMBER_FIELDS = { exitCode: 'Exit code', httpStatus: 'HTTP status' } as const;

/** Display order; `client` and `sdk` are formatted, the rest render as stored. */
const REPORT_ORDER = [
  'about',
  'kind',
  'ref',
  'client',
  'agent',
  'os',
  'arch',
  'command',
  'exitCode',
  'httpStatus',
  'sdk',
  'appSlug',
  'errorExcerpt',
] as const;

const isInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value);
const isId = (value: unknown): value is number => isInt(value) && value > 0;

/** `{ name, version }` with exactly those two string keys — the client and each SDK entry. */
const isNameVersion = (value: unknown): value is { name: string; version: string } =>
  isPlainObject(value) &&
  isString(value.name) &&
  isString(value.version) &&
  Object.keys(value).length === 2;

const isSample = (value: unknown): boolean =>
  isPlainObject(value) &&
  isString(value.text) &&
  (value.userId === undefined || isInt(value.userId)) &&
  (value.clientVersion === undefined || isString(value.clientVersion)) &&
  Object.keys(value).every((k) => k === 'text' || k === 'userId' || k === 'clientVersion');

/** A link only when the URL is on the docs host itself; a prefix check alone is not a host check. */
function docHref(url: string): string | null {
  if (!url.startsWith(PLATFORM_FEEDBACK_DOC_URL_PREFIX)) return null;
  try {
    return new URL(url).origin === new URL(PLATFORM_FEEDBACK_DOC_URL_PREFIX).origin ? url : null;
  } catch {
    return null;
  }
}

/**
 * Field by field, like the service's `platformFeedbackServerStateSchema`: a bad field is dropped and
 * the rest still count, so the panel never says "no resolution" over a note reporters are being read.
 * What it drops, and any key it does not know, goes to `leftover` for the "Other context" dump.
 */
function parseResolution(value: Record<string, unknown>): {
  resolution: PlatformResolution | null;
  leftover: Record<string, unknown> | null;
} {
  const { fixedIn, publicNote, at, byId, ...leftover } = value;
  const resolution: PlatformResolution = { fixedIn: null, publicNote: null, at: null, byId: null };
  if (isPlainObject(fixedIn) && isString(fixedIn.component) && isString(fixedIn.version))
    resolution.fixedIn = { component: fixedIn.component, version: fixedIn.version };
  else if (fixedIn !== undefined) leftover.fixedIn = fixedIn;
  if (isString(publicNote)) resolution.publicNote = publicNote;
  else if (publicNote !== undefined) leftover.publicNote = publicNote;
  if (isString(at)) resolution.at = at;
  else if (at !== undefined) leftover.at = at;
  if (isInt(byId)) resolution.byId = byId;
  else if (byId !== undefined) leftover.byId = byId;

  const any = Object.values(resolution).some((v) => v !== null);
  return {
    resolution: any ? resolution : null,
    leftover: Object.keys(leftover).length ? leftover : null,
  };
}

/**
 * Splits an `apps-platform` row's `context` into what the platform panel renders.
 *
 * Never throws, whatever the column holds: a key of an unexpected type, an unknown key, or a
 * malformed array is moved to `other` and shown as a JSON dump rather than dropped — the same rule
 * `splitContext` applies to the other areas.
 */
export function splitPlatformContext(context: unknown): PlatformFeedbackContext {
  const out: PlatformFeedbackContext = {
    report: [],
    doc: null,
    fingerprint: null,
    reporters: null,
    reports: null,
    reporterIdCount: null,
    firstSeenAt: null,
    lastSeenAt: null,
    reopenOf: null,
    regressionOf: null,
    resolution: null,
    samples: [],
    other: null,
  };
  if (!isPlainObject(context)) {
    if (context !== null && context !== undefined) out.other = { context };
    return out;
  }

  const other: Record<string, unknown> = {};
  const { report, server, ...topLevel } = context;
  Object.assign(other, topLevel);

  if (isPlainObject(report)) {
    const leftover: Record<string, unknown> = {};
    const known = new Set<string>(REPORT_ORDER);
    for (const key of REPORT_ORDER) {
      const value = report[key];
      if (value === undefined) continue;
      let text: string | null = null;
      let label: string = key;
      if (key === 'client') {
        label = 'Client';
        if (isNameVersion(value)) text = `${value.name} ${value.version}`;
      } else if (key === 'sdk') {
        label = 'SDK';
        if (Array.isArray(value) && value.every(isNameVersion))
          text = value.map((s) => `${s.name} ${s.version}`).join(', ');
      } else if (key in REPORT_NUMBER_FIELDS) {
        label = REPORT_NUMBER_FIELDS[key as keyof typeof REPORT_NUMBER_FIELDS];
        if (isInt(value)) text = String(value);
      } else {
        label = REPORT_TEXT_FIELDS[key as keyof typeof REPORT_TEXT_FIELDS];
        if (isString(value)) text = value;
      }
      if (text === null) leftover[key] = value;
      else out.report.push({ key, label, text });
    }
    for (const [key, value] of Object.entries(report)) {
      if (key === 'docUrl' && isString(value)) out.doc = { text: value, href: docHref(value) };
      else if (!known.has(key)) leftover[key] = value;
    }
    if (Object.keys(leftover).length) other.report = leftover;
  } else if (report !== undefined) {
    other.report = report;
  }

  if (isPlainObject(server)) {
    const leftover: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(server)) {
      if (key === 'resolution' && isPlainObject(value)) {
        const parsed = parseResolution(value);
        out.resolution = parsed.resolution;
        if (parsed.leftover) leftover.resolution = parsed.leftover;
      } else if (key === 'fingerprint' && isString(value)) out.fingerprint = value;
      else if (key === 'reporters' && isInt(value)) out.reporters = value;
      else if (key === 'reports' && isInt(value)) out.reports = value;
      else if (key === 'reporterIds' && Array.isArray(value)) out.reporterIdCount = value.length;
      else if (key === 'firstSeenAt' && isString(value)) out.firstSeenAt = value;
      else if (key === 'lastSeenAt' && isString(value)) out.lastSeenAt = value;
      else if (key === 'reopenOf' && isId(value)) out.reopenOf = value;
      else if (key === 'regressionOf' && isId(value)) out.regressionOf = value;
      else if (key === 'samples' && Array.isArray(value) && value.every(isSample))
        out.samples = (value as Record<string, unknown>[]).map((s) => ({
          userId: isInt(s.userId) ? s.userId : null,
          text: s.text as string,
          clientVersion: isString(s.clientVersion) ? s.clientVersion : null,
        }));
      // `reporterIds` of the wrong type is dumped as-is, but a valid one never reaches the dump:
      // the panel shows how many reporters there are, not who they are.
      else leftover[key] = value;
    }
    if (Object.keys(leftover).length) other.server = leftover;
  } else if (server !== undefined) {
    other.server = server;
  }

  if (Object.keys(other).length) out.other = other;
  return out;
}
