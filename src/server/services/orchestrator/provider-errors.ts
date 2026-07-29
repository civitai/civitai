// External-provider generation error handling.
//
// External providers (xAI/Grok, and Fal-routed engines like Flux/SeeDream) report
// failures as a job-level `reason` rather than on `step.output.errors`, so the old
// collection (which only read `step.output.errors`) dropped them and users saw a
// generic "generation error". `extractStepErrors` looks in every place a failed step
// can carry a message; `sanitizeProviderError` decides what is safe to show.

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
};

export function providerName(engine?: string): string | undefined {
  return engine ? providerNameMap[engine.toLowerCase()] : undefined;
}

/**
 * Collect raw error strings from every place a failed step can carry them —
 * `step.output.errors` / TOS message, failed `step.jobs[].reason`, and
 * `step.metadata.error`. Deduped. The job path is the one that actually surfaces
 * external-provider failures; the rest preserve prior behavior.
 */
export function extractStepErrors(step: unknown): string[] {
  const s = step as {
    output?: { errors?: unknown; message?: unknown; externalTOSViolation?: unknown };
    jobs?: Array<{
      status?: string;
      reason?: unknown;
      error?: unknown;
      message?: unknown;
      errors?: unknown;
    }>;
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

  if (Array.isArray(s.jobs)) {
    for (const job of s.jobs) {
      if (job?.status !== 'failed') continue;
      push(job.reason ?? job.error ?? job.message);
      pushAll(job.errors);
    }
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

function isLikelySafeMessage(msg: string): boolean {
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
