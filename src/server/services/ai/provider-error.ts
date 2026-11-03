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

export const PROVIDER_ERROR_LOG_LIMIT = 1024;
const SECRET_WINDOW = 16;
const SECRET_MIN = 8;
const SCAN_LIMIT = 1024 * 1024;

type Bag = Record<string, unknown>;
const asBag = (value: unknown): Bag | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Bag) : undefined;

function scalar(value: unknown, shape = SCALAR): string | undefined {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return typeof value === 'string' && shape.test(value) ? value : undefined;
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

const normalize = (text: string) =>
  text
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');

// The backstop for a provider that puts prompt text in one of the kept fields: any 16-character
// stretch of a text we sent condemns the whole line.
function echoesSecret(output: string, secrets: (string | null | undefined)[]) {
  const haystack = normalize(output);
  return secrets.some((secret) => {
    const needle = normalize(typeof secret === 'string' ? secret : '').trim();
    if (needle.length < SECRET_MIN) return false;
    if (needle.length <= SECRET_WINDOW) return haystack.includes(needle);
    for (let i = 0; i + SECRET_WINDOW <= needle.length; i++)
      if (haystack.includes(needle.slice(i, i + SECRET_WINDOW))) return true;
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
    const facts: [string, string | undefined][] = [
      ['error', scalar(e?.name) ?? (error === undefined || error === null ? 'none' : typeof error)],
      ['http', scalar(e?.statusCode)],
      ['errno', scalar(e?.code)],
      ...bodyFacts(body, ''),
    ];
    const line = facts
      .filter((fact): fact is [string, string] => fact[1] !== undefined)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ')
      .slice(0, maxLength);
    return echoesSecret(line, sent) ? 'provider error that echoed the request (redacted)' : line;
  } catch {
    // A log line must not take down the error path that wanted it.
    return 'unreadable provider error';
  }
}
