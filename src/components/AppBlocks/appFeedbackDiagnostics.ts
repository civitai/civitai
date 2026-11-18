import type {
  AppFeedbackBrowserFamily,
  AppFeedbackEnvironment,
  AppFeedbackHostReason,
  AppFeedbackOsFamily,
  AppFeedbackRecentError,
} from '~/server/schema/app-feedback.schema';
import {
  APP_FEEDBACK_APP_ROUTE_MAX,
  APP_FEEDBACK_ERROR_MESSAGE_MAX,
  APP_FEEDBACK_LONE_SURROGATE,
  APP_FEEDBACK_RECENT_ERRORS_MAX,
  APP_FEEDBACK_UNSAFE_CHARS,
} from '~/server/schema/app-feedback.schema';

/**
 * The diagnostics a feedback report carries about the running APP (never about civitai.com):
 * the replies the host sent it that reported a failure. Pure, so the node `unit` project covers
 * them; `usePostMessage` keeps the buffer.
 */

/** Older failures are dropped: they describe an earlier stretch of the session, not this report. */
export const APP_FEEDBACK_RECENT_ERRORS_MAX_AGE_MS = 30 * 60 * 1000;

const BRIDGE_TYPE = /^[A-Z][A-Z0-9_]{0,63}$/;
const OPAQUE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
/** `failureSnapshot`'s placeholder id for a workflow that never got one. */
const NO_WORKFLOW_ID = 'failed';
const FALLBACK_MESSAGE = 'request failed';

const CONTROL_CHARS = APP_FEEDBACK_UNSAFE_CHARS;

/**
 * At most `max` UTF-16 units (the unit the server's `.max()` counts), never ending on half of a
 * surrogate pair, and with any lone surrogate already in the text removed: either would make the
 * stored JSON invalid and the report fail to save.
 */
function clampUnits(text: string, max: number): string {
  const whole = text.replace(APP_FEEDBACK_LONE_SURROGATE, '');
  if (whole.length <= max) return whole;
  const cut = whole.slice(0, max);
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}

export function clampErrorText(text: string): string {
  const flat = clampUnits(text.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim(), Infinity);
  if (flat.length <= APP_FEEDBACK_ERROR_MESSAGE_MAX) return flat;
  return `${clampUnits(flat, APP_FEEDBACK_ERROR_MESSAGE_MAX - 1)}…`;
}

function opaqueId(value: unknown, max = 128): string | undefined {
  return typeof value === 'string' && value.length <= max && OPAQUE_ID.test(value)
    ? value
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The failure a host→app message reports, or `null` when it reports none. The reply shapes are the
 * bridge's own: a workflow snapshot with `status: 'failed'`, an `ok: false` refusal, or a bare
 * `error`. Reads only those fields — never `token`, `value`, `snapshot.output` or anything else the
 * payload carries.
 */
export function failureFromHostMessage(
  type: string,
  payload: unknown,
  at: number
): AppFeedbackRecentError | null {
  if (!BRIDGE_TYPE.test(type)) return null;
  const body = asRecord(payload);
  if (!body) return null;

  let message: unknown;
  let workflowId: string | undefined;
  let code = opaqueId(body.code, 64);
  const snapshot = asRecord(body.snapshot);
  const error = asRecord(body.error);
  if (snapshot?.status === 'failed') {
    message = snapshot.error;
    const id = opaqueId(snapshot.workflowId);
    workflowId = id === NO_WORKFLOW_ID ? undefined : id;
  } else if (typeof body.error === 'string' && body.error.length > 0) {
    message = body.error;
  } else if (error) {
    message = error.message;
    code ??= opaqueId(error.code, 64);
  } else if (body.ok === false) {
    message = undefined;
  } else {
    return null;
  }

  const text = typeof message === 'string' ? clampErrorText(message) : '';
  return {
    method: type,
    message: text || FALLBACK_MESSAGE,
    ...(code ? { code } : {}),
    ...(workflowId ? { workflowId } : {}),
    at,
    count: 1,
  };
}

const ENUM_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export type AppFeedbackRequestHint = {
  /** The app's request type, e.g. `SUBMIT_WORKFLOW`, named in place of the reply's. */
  method: string;
  input?: NonNullable<AppFeedbackRecentError['input']>;
};

/**
 * What a failure entry may say about the app's request: its type, and from a workflow `body` only
 * the `kind` / `step` enum keys and the checkpoint `modelVersionId`. Prompts, params, images and
 * every other field are never read.
 */
export function requestHintFromBlockMessage(
  type: string,
  payload: unknown
): AppFeedbackRequestHint | null {
  if (!BRIDGE_TYPE.test(type)) return null;
  const body = asRecord(asRecord(payload)?.body);
  if (!body) return { method: type };
  const enumKey = (value: unknown) =>
    typeof value === 'string' && ENUM_KEY.test(value) ? value : undefined;
  const kind = enumKey(body.kind);
  const step = enumKey(body.step);
  const modelVersionId =
    typeof body.modelVersionId === 'number' &&
    Number.isSafeInteger(body.modelVersionId) &&
    body.modelVersionId > 0
      ? body.modelVersionId
      : undefined;
  const input = {
    ...(kind ? { kind } : {}),
    ...(step ? { step } : {}),
    ...(modelVersionId ? { modelVersionId } : {}),
  };
  return Object.keys(input).length ? { method: type, input } : { method: type };
}

/** The failure, named after the request it answered when the bridge saw that request. */
export function withRequestHint(
  failure: AppFeedbackRecentError,
  hint: AppFeedbackRequestHint | undefined
): AppFeedbackRecentError {
  if (!hint) return failure;
  return { ...failure, method: hint.method, ...(hint.input ? { input: hint.input } : {}) };
}

const HOST_REASON_MESSAGES: Readonly<Record<AppFeedbackHostReason, string>> = Object.freeze({
  rate_limited: 'Dropped by the host: the app sent more than 30 messages in a second.',
  deduped: 'Dropped by the host: the same requestId was sent again within 5 seconds.',
  no_handler: 'Dropped by the host: this host does not handle this message type.',
  not_applicable: 'Dropped by the host: this message type does not apply on this surface.',
  validator_rejected: "The app's SDK rejected the host's reply to this request.",
  review_mode: 'Refused by the host: not available in the moderation review preview.',
  not_ready: 'Refused by the host: the app had not finished its handshake.',
  refused: 'Refused by the host: the request was not valid on this surface.',
  rewritten:
    "Carried out differently than worded: no scope was given, so the path was resolved inside the app's own route.",
});

/** An entry for a request the host dropped, refused or rewrote; `null` for a non-bridge type. */
export function hostRefusal(
  method: string,
  reason: AppFeedbackHostReason,
  at: number,
  extra: Pick<AppFeedbackRecentError, 'scope' | 'appRoute'> = {}
): AppFeedbackRecentError | null {
  if (!BRIDGE_TYPE.test(method)) return null;
  return { method, message: HOST_REASON_MESSAGES[reason], reason, ...extra, at, count: 1 };
}

/** The app-relative path of a NAVIGATE: no query, no fragment, no control characters, capped. */
function appRelativeRoute(path: string): string {
  const bare = path.split(/[?#]/, 1)[0].replace(CONTROL_CHARS, '').trim();
  return clampUnits(`/${bare.replace(/^\/+/, '')}`, APP_FEEDBACK_APP_ROUTE_MAX);
}

/**
 * What a NAVIGATE the host refused or rewrote should record, or `null` when it went as asked.
 * `resolved` is the host's resolution (`null` = refused). The one rewrite recorded is the silent
 * one: a path with a leading slash and no `scope`, which reads as site-absolute but is resolved
 * inside the app's own route.
 */
export function navigateDiagnostic(
  raw: unknown,
  resolved: { scope: 'app' | 'site' } | null,
  at: number
): AppFeedbackRecentError | null {
  const body = asRecord(raw);
  const requested =
    body?.scope === 'site' ? 'site' : body?.scope === 'app' ? 'app' : ('unspecified' as const);
  if (!resolved) return hostRefusal('NAVIGATE', 'refused', at, { scope: { requested } });
  const path = typeof body?.path === 'string' ? body.path : '';
  if (requested === 'unspecified' && path.startsWith('/') && resolved.scope === 'app')
    return hostRefusal('NAVIGATE', 'rewritten', at, {
      scope: { requested, resolved: resolved.scope },
      appRoute: appRelativeRoute(path),
    });
  return null;
}

const sameFailure = (a: AppFeedbackRecentError, b: AppFeedbackRecentError) =>
  a.method === b.method &&
  a.message === b.message &&
  a.code === b.code &&
  a.workflowId === b.workflowId &&
  a.appRoute === b.appRoute &&
  JSON.stringify(a.input ?? null) === JSON.stringify(b.input ?? null);

/**
 * Append a failure, newest last. A repeat of the newest entry (a poll failing the same way each
 * time) bumps its count instead of evicting older, different failures.
 */
export function pushRecentError(
  list: readonly AppFeedbackRecentError[],
  entry: AppFeedbackRecentError
): AppFeedbackRecentError[] {
  const last = list[list.length - 1];
  if (last && sameFailure(last, entry))
    return [...list.slice(0, -1), { ...entry, count: Math.min(last.count + 1, 10_000) }];
  return [...list, entry].slice(-APP_FEEDBACK_RECENT_ERRORS_MAX);
}

/** The entries still inside the time box at `now`. */
export function recentErrorsAt(
  list: readonly AppFeedbackRecentError[],
  now: number
): AppFeedbackRecentError[] {
  return list.filter((e) => now - e.at <= APP_FEEDBACK_RECENT_ERRORS_MAX_AGE_MS);
}

type Brand = { brand: string; version: string };

/** Most specific first: Edge, Opera and Samsung Internet also say "Chrome", and Chrome "Safari". */
const UA_BROWSERS: ReadonlyArray<[AppFeedbackBrowserFamily, RegExp]> = [
  ['edge', /\bEdg(?:e|A|iOS)?\/(\d+)/],
  ['opera', /\b(?:OPR|Opera)\/(\d+)/],
  ['samsung', /\bSamsungBrowser\/(\d+)/],
  ['firefox', /\b(?:Firefox|FxiOS)\/(\d+)/],
  ['chrome', /\b(?:Chrome|CriOS)\/(\d+)/],
  ['safari', /\bVersion\/(\d+)[^ ]* (?:Mobile\/\S+ )?Safari\//],
];

const BRANDS: ReadonlyArray<[AppFeedbackBrowserFamily, string]> = [
  ['edge', 'Microsoft Edge'],
  ['opera', 'Opera'],
  ['samsung', 'Samsung Internet'],
  ['chrome', 'Google Chrome'],
  ['chrome', 'Chromium'],
];

const major = (value: string | undefined) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isInteger(n) && n >= 0 && n <= 9999 ? n : undefined;
};

/**
 * Browser family and major version, the only part of the user agent a report keeps. Client hints
 * first (they name the browser directly), then the user-agent string.
 */
export function browserFromUserAgent(
  userAgent: string,
  brands?: readonly Brand[]
): NonNullable<AppFeedbackEnvironment['browser']> {
  for (const [family, name] of BRANDS) {
    const brand = brands?.find((b) => b.brand === name);
    if (brand) {
      const version = major(brand.version);
      return version === undefined ? { family } : { family, major: version };
    }
  }
  for (const [family, pattern] of UA_BROWSERS) {
    const match = pattern.exec(userAgent);
    if (match) {
      const version = major(match[1]);
      return version === undefined ? { family } : { family, major: version };
    }
  }
  return { family: 'other' };
}

/** Most specific first: Android says "Linux", iPadOS can say "Macintosh". */
const UA_OS: ReadonlyArray<[AppFeedbackOsFamily, RegExp]> = [
  ['android', /\bAndroid\b/],
  ['ios', /\b(?:iPhone|iPad|iPod)\b/],
  ['chromeos', /\bCrOS\b/],
  ['windows', /\bWindows\b/],
  ['macos', /\bMac OS X\b|\bMacintosh\b/],
  ['linux', /\bLinux\b|\bX11\b/],
];

const HINT_OS: Readonly<Record<string, AppFeedbackOsFamily>> = {
  Windows: 'windows',
  macOS: 'macos',
  Linux: 'linux',
  'Chrome OS': 'chromeos',
  ChromeOS: 'chromeos',
  Android: 'android',
  iOS: 'ios',
};

/** OS family only, from the client-hint platform when there is one, else the user-agent string. */
export function osFromUserAgent(userAgent: string, platform?: string): AppFeedbackOsFamily {
  if (platform && HINT_OS[platform]) return HINT_OS[platform];
  for (const [family, pattern] of UA_OS) if (pattern.test(userAgent)) return family;
  return 'other';
}

const dimension = (value: number) =>
  Number.isFinite(value) ? Math.min(Math.max(Math.round(value), 0), 100_000) : 0;

/** The environment block, from values the caller read off `window` / `navigator`. */
export function buildAppFeedbackEnvironment(input: {
  userAgent: string;
  brands?: readonly Brand[];
  platform?: string;
  /** Width a scrolling box loses to its scrollbar; 0 = overlay scrollbars. */
  scrollbarWidth?: number;
  innerWidth: number;
  innerHeight: number;
  devicePixelRatio: number;
  appRoute?: string;
}): AppFeedbackEnvironment {
  const dpr = Math.round(input.devicePixelRatio * 100) / 100;
  const route =
    input.appRoute !== undefined
      ? clampUnits(input.appRoute.replace(CONTROL_CHARS, '').trim(), APP_FEEDBACK_APP_ROUTE_MAX)
      : undefined;
  return {
    browser: browserFromUserAgent(input.userAgent, input.brands),
    os: osFromUserAgent(input.userAgent, input.platform),
    ...(input.scrollbarWidth !== undefined && Number.isFinite(input.scrollbarWidth)
      ? { scrollbars: input.scrollbarWidth > 0 ? ('classic' as const) : ('overlay' as const) }
      : {}),
    viewport: { width: dimension(input.innerWidth), height: dimension(input.innerHeight) },
    ...(dpr >= 0.1 && dpr <= 16 ? { devicePixelRatio: dpr } : {}),
    ...(route ? { appRoute: route } : {}),
  };
}

function measureScrollbarWidth(): number | undefined {
  if (typeof document === 'undefined' || !document.body) return undefined;
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll;visibility:hidden';
  document.body.appendChild(probe);
  try {
    return probe.offsetWidth - probe.clientWidth;
  } finally {
    probe.remove();
  }
}

/** `buildAppFeedbackEnvironment` over this window; `undefined` outside a browser. */
export function readAppFeedbackEnvironment(appRoute?: string): AppFeedbackEnvironment | undefined {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return undefined;
  try {
    const hints = (
      navigator as Navigator & { userAgentData?: { brands?: Brand[]; platform?: string } }
    ).userAgentData;
    return buildAppFeedbackEnvironment({
      userAgent: navigator.userAgent,
      brands: hints?.brands,
      platform: hints?.platform,
      scrollbarWidth: measureScrollbarWidth(),
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      appRoute,
    });
  } catch {
    return undefined;
  }
}
