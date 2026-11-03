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
  'provider_name',
  'model_slug',
  'raw',
]);
// Arrays hold the echoed chat turns, so their strings go unless they are these category labels.
const KEPT_ARRAY_KEYS = new Set(['reasons']);
// A key-shaped echo anywhere, in JSON at any escape depth, a Python repr ('input': ...) or
// pydantic's `input_value=`, including inside a longer name.
const ECHO_ANYWHERE_PATTERN =
  /(?:input|content|messages|prompt|text|instructions|system)[\w[\].]{0,40}\\*["']?\s*(?:[:=>：]|->)/i;
// Escapes and encodings that can hide a quote or a key from the two patterns above.
const ENCODED_PATTERN = /\\[u"'/x\\]|%[0-9a-fA-F]{2}|&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/;
// Bounds the regex work; far more than the log line keeps.
const SCAN_LIMIT = 1024 * 1024;
const FREE_TEXT_LIMIT = 300;
const MAX_DEPTH = 32;

function keepDiagnostics(value: unknown, key = '', depth = 0, inArray = false): unknown {
  if (depth > MAX_DEPTH) return '[redacted]';
  const lowerKey = key.toLowerCase();
  if (typeof value === 'string') {
    const kept = inArray ? KEPT_ARRAY_KEYS.has(lowerKey) : KEPT_STRING_KEYS.has(lowerKey);
    return kept ? redactFreeText(value) : '[redacted]';
  }
  if (Array.isArray(value)) return value.map((item) => keepDiagnostics(item, key, depth + 1, true));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, item]) => [k, keepDiagnostics(item, k, depth + 1, inArray)])
    );
  return value;
}

// Free text quotes what it echoes (Google quotes the rejected value; a Python repr quotes every
// value, serde backticks it), so quoted runs go too, through to the end of the text when unclosed.
// A single pass rather than a regex: an unclosed run must not cost a rescan from every quote.
function removeQuoted(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const opens = ch === '"' || ch === '`' || (ch === "'" && !/[A-Za-z]/.test(text[i - 1] ?? ''));
    if (!opens) {
      out += ch;
      i++;
      continue;
    }
    i++;
    while (i < text.length && text[i] !== ch) i += text[i] === '\\' ? 2 : 1;
    i++;
    out += '[quoted]';
  }
  return out;
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
// own as `metadata.raw`. Anything else is free text, and the user's prompt can be anywhere in it.
function redactFreeText(text: string): string {
  const parsed = parseJson(text);
  if (parsed !== undefined) return JSON.stringify(keepDiagnostics(parsed));
  // Decoding would let attacker-written escapes close a quote early, so encoded text is not read.
  if (ENCODED_PATTERN.test(text)) return '[encoded text redacted]';
  const echo = ECHO_ANYWHERE_PATTERN.exec(text);
  const cut = removeQuoted(echo ? text.slice(0, echo.index) : text);
  const result = echo ? `${cut}[echoed request redacted]` : cut;
  return result.length > FREE_TEXT_LIMIT ? `${result.slice(0, FREE_TEXT_LIMIT)}…` : result;
}

// Scheme, `data:` or scheme-relative.
const URL_PATTERN = /(?:\b(?:https?:|data:)|(?<![:\w])(?=\/\/[\w-]+\.))(?:\/\/)?[^\s"'<>]+/gi;
// Bearer/Basic credentials, `sk-`-style and Google API keys, and any long opaque run (signatures,
// JWT parts, base64).
const TOKEN_PATTERN =
  /\b(?:Bearer|Basic)\s+[^\s"']+|\bsk-[\w-]{8,}|\bAIza[\w-]{20,}|[\w+/=-]{32,}/gi;

export const PROVIDER_ERROR_LOG_LIMIT = 1024;
const SECRET_WINDOW = 16;
const SECRET_MIN = 8;

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, ' ');

// The backstop for prose a provider writes around an echo, which no shape rule can see: any
// 16-character stretch of a text we sent condemns the whole line.
function echoesSecret(output: string, secrets: (string | null | undefined)[]) {
  const haystack = normalize(output);
  return secrets.some((secret) => {
    const needle = normalize(secret ?? '').trim();
    if (needle.length < SECRET_MIN) return false;
    if (needle.length <= SECRET_WINDOW) return haystack.includes(needle);
    for (let i = 0; i + SECRET_WINDOW <= needle.length; i++)
      if (haystack.includes(needle.slice(i, i + SECRET_WINDOW))) return true;
    return false;
  });
}

/**
 * The provider's error, fit for a log line: the message plus the raw body, with URLs (signed image
 * URLs among them) and credential-looking strings removed, capped at ~1 KB. `sent` is the text
 * the request carried (prompts); a line that repeats any of it is replaced whole.
 */
export function describeProviderError(
  error: unknown,
  {
    sent = [],
    maxLength = PROVIDER_ERROR_LOG_LIMIT,
  }: { sent?: (string | null | undefined)[]; maxLength?: number } = {}
) {
  try {
    const all = [...new Set(errorTextParts(error))].map((part) => part.slice(0, SCAN_LIMIT));
    // When the SDK has the body, its message is either generic or a copy of that body as free
    // text (`API error occurred: … Body: …`), which the parsed body already covers.
    const hasBody = all.some((part) => parseJson(part) !== undefined);
    const parts = hasBody ? all.filter((part) => parseJson(part) !== undefined) : all;
    const text = (parts.length ? parts : [safeStringify(error)]).map(redactFreeText).join('\n');
    const redacted = text.replace(URL_PATTERN, '[url]').replace(TOKEN_PATTERN, '[redacted]');
    const line = redacted.length > maxLength ? `${redacted.slice(0, maxLength - 1)}…` : redacted;
    return echoesSecret(line, sent) ? 'provider error that echoed the request (redacted)' : line;
  } catch {
    // A log line must not take down the error path that wanted it.
    return 'unreadable provider error';
  }
}
