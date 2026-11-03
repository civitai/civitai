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

// OpenAI-compatible backends echo the offending request field in validation errors, and the
// request carries the system prompt and the submitter's prompt, so those values never reach a log.
const ECHOED_FIELDS = new Set(['input', 'content', 'messages', 'prompt', 'text', 'system']);
const ECHOED_KEY_PATTERN = /"(input|content|messages|prompt|text|system)"\s*:/i;

function redactEchoedValue(value: unknown): unknown {
  if (typeof value === 'string') return redactEchoedText(value);
  if (Array.isArray(value)) return value.map(redactEchoedValue);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        ECHOED_FIELDS.has(key.toLowerCase()) ? '[redacted]' : redactEchoedValue(item),
      ])
    );
  return value;
}

// Parsed, not pattern-matched: the echoed text is user-written and can contain any quote or
// bracket. A body that will not parse (cut off, not JSON) loses everything from the first echoed
// key on.
function redactEchoedText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(redactEchoedValue(JSON.parse(trimmed)));
    } catch {
      // falls through to the truncation below
    }
  }
  const unescaped = text.replace(/\\(["/])/g, '$1');
  const echoed = ECHOED_KEY_PATTERN.exec(unescaped);
  return echoed ? `${unescaped.slice(0, echoed.index)}"${echoed[1]}":[redacted]…` : unescaped;
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
  const parts = [...new Set(errorTextParts(error))];
  const text = (parts.length ? parts : [safeStringify(error)]).map(redactEchoedText).join('\n');
  // A provider's own error usually arrives as a JSON string inside OpenRouter's JSON envelope, so
  // one level of escaping is undone first or the patterns below cannot see its URLs.
  const redacted = text
    .replace(/\\(["/])/g, '$1')
    .replace(URL_PATTERN, '[url]')
    .replace(TOKEN_PATTERN, '[redacted]');
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength - 1)}…` : redacted;
}
