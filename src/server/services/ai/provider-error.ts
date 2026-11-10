/**
 * Where an `@openrouter/sdk` `ChatError` keeps the provider's own words.
 *
 * 🔴 `.message` alone is NOT enough. A `ChatError` builds its message from `error.message`, which
 * for most provider failures is the entirely generic "Provider returned error"; the provider's
 * actual reason sits in the raw HTTP body on `.body` (and the identical `.data$.body$`).
 */
function errorTextParts(error: unknown): string[] {
  if (error == null) return [];
  if (typeof error !== 'object') return [String(error)];

  const e = error as { message?: unknown; body?: unknown; data$?: { body$?: unknown } };
  return [e.message, e.body, e.data$?.body$].filter(
    (part): part is string => typeof part === 'string' && part.length > 0
  );
}

/**
 * Everywhere a provider reason can hide on one thrown error, joined. The whole-object stringify at
 * the end is the backstop for a provider that nests it somewhere else again.
 */
export function serializeError(error: unknown): string {
  return [...errorTextParts(error), safeStringify(error)]
    .filter((part) => part.length > 0)
    .join('\n');
}

// Error's own fields are non-enumerable (hence `.message` being read separately), and
// rawResponse/request$/response$ are both cyclic and useless here.
function safeStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return '';
  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(value, (_key, item) => {
        if (typeof item !== 'object' || item === null) return item;
        if (seen.has(item)) return undefined;
        seen.add(item);
        const name = item.constructor?.name;
        if (name === 'Request' || name === 'Response' || name === 'Headers') return undefined;
        return item;
      }) ?? ''
    );
  } catch {
    return '';
  }
}

// Anything a provider writes in prose can carry the prompts it was sent, in forms no redaction
// keeps up with, so the log line is built only from short scalars under these fixed keys.
const SCALAR = /^[\w.:/-]{1,40}$/;
const NAME_SCALAR = /^[\w .:/()-]{1,40}$/;
// A scheme-less host/path (cdn.example/a.jpg) still passes: it has the shape of a model slug.
const NOT_A_SCALAR = /:\/\/|^(basic|bearer|token)\s/i;

/** Messages the app's own AI clients throw, logged by tag since no other message text is. */
export const APP_ERROR_MESSAGES = {
  no_content: 'No content in response',
  json_parse: 'Failed to parse JSON from completion',
  no_choice: 'No choice in agent loop response',
} as const;
const APP_ERROR_TAGS = new Map<unknown, string>(
  Object.entries(APP_ERROR_MESSAGES).map(([tag, message]) => [message, tag])
);

export const PROVIDER_ERROR_LOG_LIMIT = 1024;
const SECRET_WINDOW = 16;
const SECRET_MIN = 8;
const SCAN_LIMIT = 1024 * 1024;

type Bag = Record<string, unknown>;
const asBag = (value: unknown): Bag | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Bag) : undefined;

function scalar(value: unknown, shape = SCALAR): string | undefined {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return typeof value === 'string' && shape.test(value) && !NOT_A_SCALAR.test(value)
    ? value
    : undefined;
}

function parseBag(text: unknown): Bag | undefined {
  if (typeof text !== 'string') return undefined;
  const trimmed = text.slice(0, SCAN_LIMIT).trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    return asBag(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

// What the OpenRouter envelope and the upstream body nested in it say about the failure.
function bodyFacts(body: Bag | undefined, prefix: string): [string, string | undefined][] {
  const error = asBag(body?.error) ?? body;
  const metadata = asBag(error?.metadata);
  const facts: [string, string | undefined][] = [
    [`${prefix}code`, scalar(error?.code)],
    [`${prefix}type`, scalar(error?.type)],
    [`${prefix}status`, scalar(error?.status)],
  ];
  if (metadata) {
    facts.push(['provider', scalar(metadata.provider_name, NAME_SCALAR)]);
    facts.push(['model', scalar(metadata.model_slug)]);
    const upstream = parseBag(metadata.raw);
    if (upstream) facts.push(...bodyFacts(upstream, 'upstream_'));
  }
  return facts;
}

// String codes only: a DOMException's numeric legacy code says nothing its name does not.
const socketCode = (bag: Bag | undefined) =>
  typeof bag?.code === 'string' ? scalar(bag.code) : undefined;

const normalize = (text: string) =>
  text
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');

// The backstop for a provider that puts prompt text in one of the kept fields: any 16-character
// stretch of a text we sent condemns the whole line. Not redactKnownValues: the allowlist already
// keeps whole prompts out, so what is left to catch is a fragment, which exact matching misses.
function echoesSecret(output: string, secrets: (string | null | undefined)[]) {
  const haystack = normalize(output);
  // The line is short and a sent text may not be, so the line's windows are the ones indexed.
  const windows = new Set<string>();
  for (let i = 0; i + SECRET_WINDOW <= haystack.length; i++)
    windows.add(haystack.slice(i, i + SECRET_WINDOW));
  return secrets.some((secret) => {
    const text = typeof secret === 'string' ? secret.slice(0, SCAN_LIMIT) : '';
    const needle = normalize(text).trim();
    if (needle.length < SECRET_MIN) return false;
    if (needle.length <= SECRET_WINDOW) return haystack.includes(needle);
    for (let i = 0; i + SECRET_WINDOW <= needle.length; i++)
      if (windows.has(needle.slice(i, i + SECRET_WINDOW))) return true;
    return false;
  });
}

/**
 * The provider's error, fit for a log line: the error class, HTTP status, provider and the error
 * codes the envelope and the upstream body carry, as `key=value` pairs. No message or other prose
 * is ever included. `sent` is the text the request carried (prompts); a line that repeats any of it
 * is replaced whole.
 */
export function describeProviderError(
  error: unknown,
  {
    sent = [],
    maxLength = PROVIDER_ERROR_LOG_LIMIT,
  }: { sent?: (string | null | undefined)[]; maxLength?: number } = {}
) {
  try {
    const e = asBag(error);
    const body = parseBag(e?.body) ?? parseBag(asBag(e?.data$)?.body$) ?? asBag(e?.error);
    // The SDK's ConnectionError wraps fetch's TypeError, which wraps the socket error's code.
    const cause = asBag(e?.cause);
    const facts: [string, string | undefined][] = [
      ['error', scalar(e?.name) ?? (error === undefined || error === null ? 'none' : typeof error)],
      ['reason', APP_ERROR_TAGS.get(e?.message)],
      ['http', scalar(e?.statusCode)],
      ['errno', scalar(e?.code)],
      ['cause', socketCode(cause) ?? socketCode(asBag(cause?.cause)) ?? scalar(cause?.name)],
      ...bodyFacts(body, ''),
    ];
    const kept = facts.filter((fact): fact is [string, string] => fact[1] !== undefined);
    const join = (pairs: [string, string][]) =>
      pairs
        .map(([key, value]) => `${key}=${value}`)
        .join(' ')
        .slice(0, maxLength);
    const line = join(kept);
    if (!echoesSecret(line, sent)) return line;
    // Too short to be a stretch of a sent text, so these survive the redaction.
    const numeric = kept.filter(([, value]) => /^\d{1,6}$/.test(value));
    return ['provider error that echoed the request (redacted)', join(numeric)]
      .filter(Boolean)
      .join(' ');
  } catch {
    // A log line must not take down the error path that wanted it.
    return 'unreadable provider error';
  }
}
