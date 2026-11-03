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

// Provider bodies echo the request, which carries the system prompt and the submitter's prompt,
// under names no list can cover (OpenRouter's own moderation error uses `flagged_input`). So a
// parsed body keeps the strings under these diagnostic keys only, and blanks every other one.
const KEPT_STRING_KEYS = new Set([
  'message',
  'msg',
  'error',
  'code',
  'type',
  'param',
  'status',
  'name',
  'provider_name',
  'model_slug',
  'reasons',
  'raw',
]);
// For text that cannot be parsed: a key-shaped echo anywhere, in JSON at any escape depth, a
// Python repr ('input': ...) or pydantic's `input_value=`, including inside a longer name.
const ECHO_ANYWHERE_PATTERN =
  /(?:input|content|messages|prompt|text|instructions|system)[\w[\].]{0,40}\\*["']?\s*(?:[:=>\uff1a]|->)/i;
// Free text quotes what it echoes (Google quotes the rejected value; a Python repr quotes every
// value, serde backticks it), so quoted runs go too, through to the end of the text when unclosed.
const QUOTED_PATTERN = /"[^"]*(?:"|$)|`[^`]*(?:`|$)|(?<![A-Za-z])'[^']*(?:'|$)/g;
// Bounds the regex work; far more than the log line keeps.
const SCAN_LIMIT = 64 * 1024;
const MAX_DEPTH = 32;
const HTML_ENTITIES: Record<string, string> = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' };

function keepDiagnostics(value: unknown, key?: string, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[redacted]';
  if (typeof value === 'string')
    return key !== undefined && KEPT_STRING_KEYS.has(key.toLowerCase())
      ? redactFreeText(value)
      : '[redacted]';
  if (Array.isArray(value)) return value.map((item) => keepDiagnostics(item, key, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, item]) => [k, keepDiagnostics(item, k, depth + 1)])
    );
  return value;
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

// Every part, and every kept string, may itself be a JSON body: OpenRouter nests the provider's
// own as `metadata.raw`.
function redactFreeText(text: string): string {
  const parsed = parseJson(text);
  if (parsed !== undefined) return JSON.stringify(keepDiagnostics(parsed));
  return cutAtEcho(text).replace(QUOTED_PATTERN, '[quoted]');
}

// The echoed text is user-written and arrives in formats no parser here knows, so the line ends at
// the first sign of one rather than trying to find where the echo stops.
function cutAtEcho(text: string): string {
  const decoded = text
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/%([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d{1,6});/g, (_, dec: string) => String.fromCharCode(Number(dec) % 0x10000))
    .replace(/&(quot|apos|lt|gt|amp);/g, (_, name: string) => HTML_ENTITIES[name])
    .replace(/\\(["/])/g, '$1');
  const echo = ECHO_ANYWHERE_PATTERN.exec(decoded);
  return echo ? `${decoded.slice(0, echo.index)}[echoed request redacted]` : decoded;
}

// Scheme, `data:` or scheme-relative.
const URL_PATTERN = /(?:\b(?:https?:|data:)|(?<![:\w])(?=\/\/[\w-]+\.))(?:\/\/)?[^\s"'<>]+/gi;
// Bearer/Basic credentials, `sk-`-style and Google API keys, and any long opaque run (signatures,
// JWT parts, base64).
const TOKEN_PATTERN =
  /\b(?:Bearer|Basic)\s+[^\s"']+|\bsk-[\w-]{8,}|\bAIza[\w-]{20,}|[\w+/=-]{32,}/gi;

export const PROVIDER_ERROR_LOG_LIMIT = 1024;

/**
 * The provider's error, fit for a log line: the message plus the raw body, with URLs (signed image
 * URLs among them) and credential-looking strings removed, capped at ~1 KB.
 */
export function describeProviderError(error: unknown, maxLength = PROVIDER_ERROR_LOG_LIMIT) {
  try {
    const parts = [...new Set(errorTextParts(error))].map((part) => part.slice(0, SCAN_LIMIT));
    const text = (parts.length ? parts : [safeStringify(error)]).map(redactFreeText).join('\n');
    const redacted = text.replace(URL_PATTERN, '[url]').replace(TOKEN_PATTERN, '[redacted]');
    return redacted.length > maxLength ? `${redacted.slice(0, maxLength - 1)}…` : redacted;
  } catch {
    // A log line must not take down the error path that wanted it.
    return 'unreadable provider error';
  }
}
