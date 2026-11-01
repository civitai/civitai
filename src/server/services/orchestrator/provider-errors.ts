import { MATURE_SOURCE_HINT } from '~/shared/constants/mature-source.constants';

// Provider generation errors. `sanitizeProviderError` decides what is safe to show a user;
// `providerNameMap` brands the message with the provider behind an engine id.

export const providerNameMap: Record<string, string> = {
  grok: 'xAI (Grok)',
  haiper: 'Haiper',
  mochi: 'Mochi',
  luma: 'Luma',
  minimax: 'Minimax',
  kling: 'Kling',
  runway: 'Runway',
  openai: 'OpenAI',
  google: 'Google',
  gemini: 'Google Gemini',
  fal: 'Fal.ai',
  flux2: 'Fal.ai (Flux)',
  'flux2-klein': 'Fal.ai (Flux Klein)',
  'flux1-kontext': 'Fal.ai (Flux Kontext)',
  seedream: 'Fal.ai (SeeDream)',
  zimage: 'Fal.ai (zImage)',
  seedance: 'Seedance',
};

export function providerName(engine?: string): string | undefined {
  return engine ? providerNameMap[engine.toLowerCase()] : undefined;
}

/** Deduped error strings from a failed step's output and metadata. */
export function extractStepErrors(step: unknown): string[] {
  const s = step as {
    output?: { errors?: unknown; message?: unknown; externalTOSViolation?: unknown };
    metadata?: { error?: unknown; errors?: unknown };
  } | null;
  if (!s) return [];

  const errors: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string') errors.push(v);
  };
  const pushAll = (v: unknown) => {
    if (Array.isArray(v)) for (const x of v) push(typeof x === 'string' ? x : String(x));
  };

  if (s.output) {
    pushAll(s.output.errors);
    if ('externalTOSViolation' in s.output) push(s.output.message);
  }

  if (s.metadata) {
    push(s.metadata.error);
    pushAll(s.metadata.errors);
  }

  return Array.from(new Set(errors.map((e) => e.trim()).filter(Boolean)));
}

// Patterns that mark a message as unsafe to show verbatim. This is a fail-safe
// design: a message is shown ONLY if it looks like plain prose; anything matching
// these (paths, URLs, serialized structures, stack frames, infra/DB errors,
// credentials) is replaced with a generic message. We default to hiding because we
// can't characterize what providers send — the opposite bias of a denylist.
const UNSAFE_PATTERNS: RegExp[] = [
  /https?:\/\//i, // URLs / internal endpoints
  /[a-zA-Z]:\\/, // Windows filesystem paths
  /(?:^|[\s('"])\/(?:[\w.-]+\/){2,}/, // absolute unix paths (/a/b/…), boundary-anchored so dates like 5/10/2024 don't trip it
  /[{}[\]<>]/, // serialized objects / HTML
  /\bat\s+[\w$.]+\s*\(/, // stack frame "at fn (" — NOT prose "at the", "at 5pm"
  /\b(?:exception|traceback|stack\s?trace|nullpointer|null reference)\b/i,
  /prisma|clickhouse|meilisearch/i, // infra names (may be camelCased, so no \b)
  /\b(?:sql|database|redis|postgres|mongo|econnrefused|connection refused)\b/i,
  /\b(?:bearer|api[_ ]?key|secret|password)\b/i, // credential leaks — deliberately NOT bare "token" (LLM token-limit errors are safe/useful)
  /\binternal server error\b/i,
];

const MAX_SAFE_LENGTH = 300;

export function isLikelySafeMessage(msg: string): boolean {
  if (!msg || msg.length > MAX_SAFE_LENGTH) return false;
  if (/[\r\n]/.test(msg)) return false; // multi-line ⇒ almost always a dump/trace
  return !UNSAFE_PATTERNS.some((re) => re.test(msg));
}

/**
 * Return a user-facing error string for a raw provider message. Plain messages are
 * passed through (prefixed with the provider name when known and not already
 * mentioned); anything that looks internal is replaced with a generic message.
 */
export function sanitizeProviderError(rawMessage: string, engine?: string): string {
  const provider = providerName(engine);
  const msg = (rawMessage ?? '').trim();

  if (!isLikelySafeMessage(msg)) {
    return provider
      ? `${provider} reported a system error. Please try again.`
      : 'The generation provider reported a system error. Please try again.';
  }

  if (!provider) return msg;

  // Avoid double-branding, e.g. "Fal.ai" already inside "Fal.ai (Flux)".
  const aliases = provider
    .toLowerCase()
    .split(/[()]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const alreadyMentioned = aliases.some((a) => msg.toLowerCase().includes(a));
  return alreadyMentioned ? msg : `${provider}: ${msg}`;
}

// Providers name the offending request part by index, e.g. "input image 'content[1]'". The
// bracket rule in UNSAFE_PATTERNS would redact the whole refusal for that token alone.
const PROVIDER_INDEX_TOKEN = /\s*'?\b\w+\[\d+\]'?/g;

const CONTENT_FILTER_REFUSAL = "The provider's content filter rejected this request.";

/** Flux 3 Video's provider rejects mature source images; other engines are not pointed at H3. */
function isFlux3ImageToVideoStep(step: unknown) {
  const s = step as { $type?: unknown; input?: { engine?: unknown; operation?: unknown } } | null;
  return (
    s?.$type === 'videoGen' && s.input?.engine === 'flux' && s.input.operation !== 'textToVideo'
  );
}

/**
 * Sanitised, user-facing errors for a failed step. A provider content refusal
 * (`externalTOSViolation`) keeps its reason; every other message is sanitised unchanged.
 */
export function sanitizeStepErrors(step: unknown, engine?: string): string[] {
  const output = (step as { output?: { externalTOSViolation?: unknown; message?: unknown } } | null)
    ?.output;
  const refused = output?.externalTOSViolation === true;
  const refusal =
    output && 'externalTOSViolation' in output && typeof output.message === 'string'
      ? output.message.trim()
      : undefined;

  const raw = extractStepErrors(step);
  const errors = raw.map((msg) =>
    sanitizeProviderError(msg === refusal ? msg.replace(PROVIDER_INDEX_TOKEN, '') : msg, engine)
  );
  if (!refused || !isFlux3ImageToVideoStep(step)) return errors;

  // A refusal too unsafe to show reads as a system error, which would contradict the hint.
  const refusalIndex = refusal ? raw.indexOf(refusal) : -1;
  const shown =
    refusalIndex >= 0 && isLikelySafeMessage(refusal!.replace(PROVIDER_INDEX_TOKEN, ''))
      ? errors[refusalIndex]
      : CONTENT_FILTER_REFUSAL;
  const withHint = `${shown} ${MATURE_SOURCE_HINT}`;
  return refusalIndex >= 0
    ? errors.map((msg, i) => (i === refusalIndex ? withHint : msg))
    : [...errors, withHint];
}
