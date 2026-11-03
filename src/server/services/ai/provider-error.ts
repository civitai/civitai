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
// request carries the system prompt, so the values of those keys never reach a log.
const ECHOED_FIELD_PATTERN =
  /"(input|content|messages|prompt|text|system)"\s*:\s*(?:"(?:[^"\\]|\\.)*"|\[[^\]]*\]?|\{[^}]*\}?)/gi;
// Scheme, `data:` or scheme-relative; the body is JSON, so `\/` is unescaped first.
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
  const text = [...new Set(errorTextParts(error))].join('\n') || safeStringify(error);
  // A provider's own error usually arrives as a JSON string inside OpenRouter's JSON envelope, so
  // one level of escaping is undone first or the patterns below cannot see its keys and URLs.
  const redacted = text
    .replace(/\\(["/])/g, '$1')
    .replace(ECHOED_FIELD_PATTERN, '"$1":"[redacted]"')
    .replace(URL_PATTERN, '[url]')
    .replace(TOKEN_PATTERN, '[redacted]');
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength - 1)}…` : redacted;
}
