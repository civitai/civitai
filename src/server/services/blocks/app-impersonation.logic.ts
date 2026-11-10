/**
 * The IMPERSONATION check of an App Block agent review — the pure half.
 *
 * What it looks for: a submission whose name, slug, listing text or listing art imitates
 * another app on the store, a real brand, trademark or company (Civitai included), or otherwise
 * tries to make people think it is something or someone it is not. Similar FUNCTIONALITY is not
 * a finding — only identity.
 *
 * Three checks, and each finding records which one fired (`check`):
 *  - `listing-name-match` (deterministic): the submission's name, normalised, equals (or is
 *    within the configured edit distance of) the name of another author's approved listing.
 *  - `protected-term` (deterministic): the submission's name or slug contains a protected brand
 *    term. The terms are moderator-managed data (the `AppProtectedBrandTerm` blocklist), never a
 *    list in this file.
 *  - `model-judgement`: a model reads the listing (text, icon, cover) for everything the two
 *    deterministic checks cannot see.
 *
 * An HONEST declaration lowers a deterministic finding to `low` (still recorded, no longer a
 * flag): a structural fork link to the matched app, or — for the model's reading of the text — a
 * quote that is verified, here, to really appear in the listing. The model cannot clear a
 * deterministic finding by asserting a declaration that is not on the page.
 *
 * No React, no Prisma, no I/O: the service (`app-impersonation-check.service.ts`) gathers the
 * inputs and persists the result.
 */

export const IMPERSONATION_CHECKS = [
  'listing-name-match',
  'protected-term',
  'model-judgement',
] as const;
export type ImpersonationCheck = (typeof IMPERSONATION_CHECKS)[number];

/** The `category` every impersonation finding carries in the security audit. */
export const IMPERSONATION_CATEGORY = 'impersonation';

export type ImpersonationSeverity = 'high' | 'medium' | 'low';

export type ImpersonationFinding = {
  severity: ImpersonationSeverity;
  category: typeof IMPERSONATION_CATEGORY;
  check: ImpersonationCheck;
  title: string;
  detail: string;
  evidence: string[];
};

export type ImpersonationCheckOutcome = 'clear' | 'fired' | 'failed';

/**
 * Stored beside the findings, in `securityAudit.impersonationCheck`. Its `status` is what the
 * review queue reads: a submission is only ever in the fast lane with a `complete` record.
 */
export type ImpersonationCheckRecord = {
  status: 'complete' | 'failed';
  ranAt: string;
  checks: Record<ImpersonationCheck, ImpersonationCheckOutcome>;
  model?: string;
  error?: string;
};

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Characters folded onto the Latin letter they are written to look like: digits and symbols
 * used as letters, and Cyrillic/Greek homoglyphs (which NFKD does not fold). `l` and `i` fold
 * together, so both spellings of a name meet in the middle.
 */
const LOOKALIKES: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '!': 'i',
  '|': 'i',
  l: 'i',
  '3': 'e',
  '4': 'a',
  '@': 'a',
  '5': 's',
  $: 's',
  '7': 't',
  '+': 't',
  '8': 'b',
  '9': 'g',
  // Cyrillic
  а: 'a',
  в: 'b',
  е: 'e',
  ё: 'e',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x',
  і: 'i',
  ї: 'i',
  ј: 'j',
  ѕ: 's',
  ԁ: 'd',
  ԛ: 'q',
  ԝ: 'w',
  // Greek
  α: 'a',
  β: 'b',
  ε: 'e',
  η: 'n',
  ι: 'i',
  κ: 'k',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x',
};

/**
 * The comparable SKELETON of a name: compatibility-decomposed, accents dropped, lower-cased,
 * look-alike characters folded, everything that is not a letter or digit removed, and the two
 * common multi-letter look-alikes (`rn` for `m`, `vv` for `w`) folded. Two names that render
 * alike end up equal here.
 */
export function impersonationSkeleton(value: string): string {
  const lowered = value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  let folded = '';
  for (const ch of lowered) folded += LOOKALIKES[ch] ?? ch;
  return folded
    .replace(/[^a-z0-9]/g, '')
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w');
}

/** Levenshtein distance, giving up (returning `max + 1`) as soon as it must exceed `max`. */
export function boundedEditDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// ---------------------------------------------------------------------------
// Deterministic checks
// ---------------------------------------------------------------------------

export type ImpersonationSubject = {
  /** The name the store shows: the listing's name, else the manifest's. */
  name: string;
  slug: string;
  tagline?: string | null;
  description?: string | null;
  /** The AppBlock this submission says it is a fork of (publish request `forkOfAppBlockId`). */
  forkOfAppBlockId?: string | null;
  /** The listing this submission's listing says it is a fork of (`forkOfListingId`). */
  forkOfListingId?: string | null;
};

export type OtherListing = {
  id: string;
  name: string;
  slug: string;
  appBlockId?: string | null;
};

/** A name skeleton shorter than this never fuzzy-matches (only an identical skeleton does). */
const MIN_FUZZY_SKELETON_LENGTH = 4;

function isDeclaredForkOf(subject: ImpersonationSubject, other: OtherListing): boolean {
  if (subject.forkOfListingId && subject.forkOfListingId === other.id) return true;
  return !!(
    subject.forkOfAppBlockId &&
    other.appBlockId &&
    subject.forkOfAppBlockId === other.appBlockId
  );
}

/**
 * `listing-name-match`: another author's approved listing whose name has the same skeleton as
 * the submission's (or one within `maxEdits`). The caller passes only OTHER authors' listings,
 * so an author's own family of apps never matches itself.
 */
export function listingNameMatchFindings(
  subject: ImpersonationSubject,
  others: readonly OtherListing[],
  maxEdits: number
): ImpersonationFinding[] {
  const mine = impersonationSkeleton(subject.name);
  if (!mine) return [];
  const edits = Number.isInteger(maxEdits) && maxEdits > 0 ? maxEdits : 0;
  const findings: ImpersonationFinding[] = [];
  for (const other of others) {
    if (other.slug === subject.slug) continue;
    const theirs = impersonationSkeleton(other.name);
    if (!theirs) continue;
    const exact = mine === theirs;
    const close =
      !exact &&
      edits > 0 &&
      Math.min(mine.length, theirs.length) >= MIN_FUZZY_SKELETON_LENGTH &&
      boundedEditDistance(mine, theirs, edits) <= edits;
    if (!exact && !close) continue;
    const fork = isDeclaredForkOf(subject, other);
    findings.push({
      severity: fork ? 'low' : 'medium',
      category: IMPERSONATION_CATEGORY,
      check: 'listing-name-match',
      title: fork
        ? `Name matches the app it declares itself a fork of ("${other.name}")`
        : `Name matches another author's app ("${other.name}")`,
      detail: fork
        ? `"${subject.name}" reads as "${other.name}" (${other.slug}), and the submission is linked to it as a fork. Recorded for the moderator; not a flag.`
        : `"${subject.name}" reads as "${other.name}" (${other.slug}), an approved app by a different author. Check the listing does not pose as that app.`,
      evidence: [
        `check: listing-name-match`,
        `matched: ${other.slug}`,
        exact ? 'identical after normalisation' : 'near-identical after normalisation',
      ],
    });
  }
  return findings;
}

/**
 * `protected-term`: the submission's NAME or SLUG contains a protected term (compared by
 * skeleton, so look-alike spellings count). The listing description is deliberately not
 * scanned: saying an app works WITH a brand is not posing as it, and the model reads the text.
 *
 * `declaration` is a verified quote of the listing honestly saying it is unofficial / a fork
 * (see {@link verifiedDeclarationQuote}); with one, a hit is recorded at `low`.
 */
export function protectedTermFindings(
  subject: ImpersonationSubject,
  terms: readonly string[],
  declaration: string | null
): ImpersonationFinding[] {
  const fields = [impersonationSkeleton(subject.name), impersonationSkeleton(subject.slug)];
  const findings: ImpersonationFinding[] = [];
  const seen = new Set<string>();
  for (const term of terms) {
    const t = impersonationSkeleton(term);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    if (!fields.some((f) => f.includes(t))) continue;
    findings.push({
      severity: declaration ? 'low' : 'medium',
      category: IMPERSONATION_CATEGORY,
      check: 'protected-term',
      title: declaration
        ? `Uses a protected brand name ("${term}"), and declares itself unofficial`
        : `Uses a protected brand name ("${term}")`,
      detail: declaration
        ? `The name or slug contains "${term}". The listing says: "${declaration}". Recorded for the moderator; not a flag.`
        : `The name or slug contains "${term}" and the listing does not say it is unofficial or a fork. Check it is not posing as that brand.`,
      evidence: [`check: protected-term`, `term: ${term}`],
    });
  }
  return findings;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Shortest quote accepted as a declaration: long enough to be a phrase, not a stray word. */
const MIN_DECLARATION_QUOTE_CHARS = 8;

/**
 * The model's quoted declaration, only when it REALLY appears in the listing text the author
 * wrote (name, tagline or description, whitespace- and case-insensitive). A quote the listing
 * does not contain is the model being misled, and is dropped.
 */
export function verifiedDeclarationQuote(
  subject: ImpersonationSubject,
  quote: unknown
): string | null {
  if (typeof quote !== 'string') return null;
  const q = collapse(quote);
  if (q.length < MIN_DECLARATION_QUOTE_CHARS) return null;
  const haystack = [subject.name, subject.tagline ?? '', subject.description ?? '']
    .map(collapse)
    .join('\n');
  return haystack.includes(q) ? quote.trim().slice(0, 300) : null;
}

// ---------------------------------------------------------------------------
// Model judgement
// ---------------------------------------------------------------------------

export type ModelJudgement = {
  findings?: unknown;
  declaredUnofficialQuote?: unknown;
};

const MAX_MODEL_FINDINGS = 5;

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t ? t.slice(0, max) : null;
}

/**
 * The model's findings, normalised: at most a few, each with a known severity (an unknown one
 * reads as `medium`, so an odd answer still flags rather than vanishing) and bounded text.
 * Adversarial-input caveat: these strings were produced while reading author-written text and
 * are rendered as inert text only.
 */
export function modelJudgementFindings(judgement: ModelJudgement | null): ImpersonationFinding[] {
  const raw = Array.isArray(judgement?.findings) ? (judgement?.findings as unknown[]) : [];
  const out: ImpersonationFinding[] = [];
  for (const f of raw) {
    if (out.length >= MAX_MODEL_FINDINGS) break;
    if (!f || typeof f !== 'object') continue;
    const o = f as Record<string, unknown>;
    const title = boundedText(o.title, 200);
    if (!title) continue;
    const sev = typeof o.severity === 'string' ? o.severity.toLowerCase() : '';
    const severity: ImpersonationSeverity =
      sev === 'high' || sev === 'low' || sev === 'medium' ? sev : 'medium';
    const quote = boundedText(o.quote, 300);
    out.push({
      severity,
      category: IMPERSONATION_CATEGORY,
      check: 'model-judgement',
      title,
      detail: boundedText(o.detail, 1000) ?? title,
      evidence: ['check: model-judgement', ...(quote ? [`quote: ${quote}`] : [])],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Storage in the security audit
// ---------------------------------------------------------------------------

function isImpersonationFinding(f: unknown): boolean {
  if (!f || typeof f !== 'object') return false;
  const o = f as Record<string, unknown>;
  return (
    o.category === IMPERSONATION_CATEGORY &&
    typeof o.check === 'string' &&
    (IMPERSONATION_CHECKS as readonly string[]).includes(o.check)
  );
}

/**
 * Drop a runner-supplied `impersonationCheck` from a security-audit slot. Only this check
 * writes that key; a bundle that talked the agent into emitting one must not be able to pass a
 * fake "complete" record through the callback.
 */
export function stripImpersonationRecord(slot: unknown): unknown {
  if (!slot || typeof slot !== 'object' || Array.isArray(slot)) return slot;
  if (!('impersonationCheck' in (slot as Record<string, unknown>))) return slot;
  const { impersonationCheck: _drop, ...rest } = slot as Record<string, unknown>;
  return rest;
}

/**
 * The security-audit slot with this run's impersonation findings and record merged in. Any
 * earlier impersonation findings are replaced (a re-run is a fresh check); the agent's own
 * findings are kept untouched.
 *
 * A slot that is not an object (absent, or a runner failure dump) becomes an `{ error }`
 * object, so it still reads as a FAILED security audit everywhere and the findings are not lost.
 */
export function mergeImpersonationIntoSecurityAudit(
  slot: unknown,
  findings: ImpersonationFinding[],
  record: ImpersonationCheckRecord,
  failureMessage: (raw: unknown) => string | null
): Record<string, unknown> {
  if (slot && typeof slot === 'object' && !Array.isArray(slot)) {
    const o = slot as Record<string, unknown>;
    const kept = Array.isArray(o.findings)
      ? o.findings.filter((f) => !isImpersonationFinding(f))
      : [];
    return { ...o, findings: [...kept, ...findings], impersonationCheck: record };
  }
  return {
    error: failureMessage(slot) ?? 'the security audit did not report',
    findings,
    impersonationCheck: record,
  };
}
