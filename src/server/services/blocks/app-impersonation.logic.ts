import type * as Crypto from 'crypto';

/**
 * The IMPERSONATION check of an App Block agent review — the pure half.
 *
 * What it looks for: a submission whose name, slug, listing text or listing art imitates
 * another app on the store, a real brand, trademark or company (Civitai included), or otherwise
 * tries to make people think it is something or someone it is not. Similar FUNCTIONALITY is not
 * a finding — only identity.
 *
 * Three checks, and each finding records which one fired (`check`):
 *  - `listing-name-match` (deterministic): the submission's name, normalised, equals the
 *    normalised name of another author's approved listing.
 *  - `protected-term` (deterministic): the submission's name or slug contains a protected brand
 *    term. The terms are moderator-managed data (the `AppProtectedBrandTerm` blocklist), never a
 *    list in this file.
 *  - `model-judgement`: a model reads the listing (text, icon, cover) for everything the two
 *    deterministic checks cannot see.
 *
 * Only a STRUCTURAL fork link to the matched app lowers a name match to `low` (still recorded, no
 * longer a flag). Nothing the listing SAYS lowers anything: a protected term in the name or slug
 * always flags, whatever the listing claims about being unofficial.
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
  /** {@link impersonationFingerprint} of the listing the check looked at. The queue compares it
   *  with the listing as it is now; a mismatch means the check is stale. */
  fingerprint?: string;
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
  // More lower-case look-alikes outside the Latin block.
  ı: 'i',
  ɑ: 'a',
  ɡ: 'g',
  һ: 'h',
  ԍ: 'g',
  օ: 'o',
};

/**
 * CAPITAL look-alikes, folded BEFORE lower-casing. Lower-casing first would send a Greek capital
 * through its own lower-case letter, which looks like something else entirely (Η → η reads as n,
 * Ν → ν as v, Υ → υ as u). Each maps to the Latin capital it looks like, lower-cased.
 */
const CAPITAL_LOOKALIKES: Record<string, string> = {
  // Greek
  Α: 'a',
  Β: 'b',
  Ε: 'e',
  Ζ: 'z',
  Η: 'h',
  Ι: 'i',
  Κ: 'k',
  Μ: 'm',
  Ν: 'n',
  Ο: 'o',
  Ρ: 'p',
  Τ: 't',
  Υ: 'y',
  Χ: 'x',
  // Cyrillic
  А: 'a',
  В: 'b',
  Е: 'e',
  К: 'k',
  М: 'm',
  Н: 'h',
  О: 'o',
  Р: 'p',
  С: 'c',
  Т: 't',
  Х: 'x',
};

/**
 * The comparable SKELETON of a name: compatibility-decomposed, accents dropped, capital
 * look-alikes folded, then lower-cased and lower-case look-alikes folded, everything that is not a letter or digit removed, and the two
 * common multi-letter look-alikes (`rn` for `m`, `vv` for `w`) folded. Two names that render
 * alike end up equal here.
 */
export function impersonationSkeleton(value: string): string {
  const stripped = value.normalize('NFKD').replace(/\p{M}/gu, '');
  let folded = '';
  for (const ch of stripped) {
    const capital = CAPITAL_LOOKALIKES[ch];
    if (capital) {
      folded += capital;
      continue;
    }
    for (const lower of ch.toLowerCase()) folded += LOOKALIKES[lower] ?? lower;
  }
  return folded
    .replace(/[^a-z0-9]/g, '')
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w');
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
 * the submission's. The caller passes only OTHER authors' listings,
 * so an author's own family of apps never matches itself.
 */
export function listingNameMatchFindings(
  subject: ImpersonationSubject,
  others: readonly OtherListing[]
): ImpersonationFinding[] {
  const mine = impersonationSkeleton(subject.name);
  if (!mine) return [];
  const findings: ImpersonationFinding[] = [];
  for (const other of others) {
    if (other.slug === subject.slug) continue;
    const theirs = impersonationSkeleton(other.name);
    if (!theirs) continue;
    if (mine !== theirs) continue;
    const fork = isDeclaredForkOf(subject, other);
    findings.push({
      severity: fork ? 'low' : 'medium',
      category: IMPERSONATION_CATEGORY,
      check: 'listing-name-match',
      title: fork
        ? `Name matches the app it is linked to as a fork ("${other.name}")`
        : `Name matches another author's app ("${other.name}")`,
      detail: fork
        ? `"${subject.name}" reads as "${other.name}" (${other.slug}), and the submission is linked to it as a fork. Recorded for the moderator; not a flag.`
        : `"${subject.name}" reads as "${other.name}" (${other.slug}), an approved app by a different author. Check the listing does not pose as that app.`,
      evidence: [
        `check: listing-name-match`,
        `matched: ${other.slug}`,
        'identical after normalisation',
      ],
    });
  }
  return findings;
}

/**
 * `protected-term`: the submission's NAME or SLUG contains a protected term (compared by
 * skeleton, so look-alike spellings count). The listing description is deliberately not
 * scanned: saying an app works WITH a brand is not posing as it, and the model reads the text.
 * A hit always flags (`medium`): nothing the listing says about being unofficial lowers it.
 */
export function protectedTermFindings(
  subject: ImpersonationSubject,
  terms: readonly string[]
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
      severity: 'medium',
      category: IMPERSONATION_CATEGORY,
      check: 'protected-term',
      title: `Uses a protected brand name ("${term}")`,
      detail: `The name or slug contains "${term}". Check the app is not posing as that brand.`,
      evidence: [`check: protected-term`, `term: ${term}`],
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Model judgement
// ---------------------------------------------------------------------------

export type ModelJudgement = {
  findings?: unknown;
};

const MAX_MODEL_FINDINGS = 5;

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t ? t.slice(0, max) : null;
}

const UNTITLED_FINDING = 'Untitled impersonation finding';

export type ParsedModelJudgement =
  | { ok: true; findings: ImpersonationFinding[] }
  | { ok: false; error: string };

/**
 * The model's answer, validated. A well-formed answer is `{ findings: [ {…}, … ] }`; anything
 * else (no object, `findings` not an array, an entry that is not an object) is a MODEL ERROR and
 * the check is incomplete — never "found nothing". Findings are normalised: at most a few, each
 * with a known severity (an unknown one reads as `medium`, so an odd answer still flags), an
 * untitled one kept under a placeholder title, text bounded. Adversarial-input caveat: these
 * strings were produced while reading author-written text and are rendered as inert text only.
 */
export function parseModelJudgement(judgement: unknown): ParsedModelJudgement {
  if (!judgement || typeof judgement !== 'object' || Array.isArray(judgement)) {
    return { ok: false, error: 'malformed model output: not an object' };
  }
  const raw = (judgement as ModelJudgement).findings;
  if (!Array.isArray(raw)) return { ok: false, error: 'malformed model output: no findings list' };
  if (raw.some((f) => !f || typeof f !== 'object' || Array.isArray(f))) {
    return { ok: false, error: 'malformed model output: a finding is not an object' };
  }
  const findings: ImpersonationFinding[] = [];
  for (const f of raw.slice(0, MAX_MODEL_FINDINGS)) {
    const o = f as Record<string, unknown>;
    const title = boundedText(o.title, 200) ?? UNTITLED_FINDING;
    const sev = typeof o.severity === 'string' ? o.severity.toLowerCase() : '';
    const severity: ImpersonationSeverity =
      sev === 'high' || sev === 'low' || sev === 'medium' ? sev : 'medium';
    const quote = boundedText(o.quote, 300);
    findings.push({
      severity,
      category: IMPERSONATION_CATEGORY,
      check: 'model-judgement',
      title,
      detail: boundedText(o.detail, 1000) ?? title,
      evidence: ['check: model-judgement', ...(quote ? [`quote: ${quote}`] : [])],
    });
  }
  return { ok: true, findings };
}

/** The listing fields the check reads. */
export type ImpersonationFingerprintInput = {
  name: string;
  slug: string;
  tagline: string | null;
  description: string | null;
  iconId: number | null;
  coverId: number | null;
};

/**
 * A digest of exactly what the impersonation check looked at. Recorded with the check and
 * recomputed from the live listing by the review queue, so an edit made in place after a clean
 * check (a new app's draft or pending listing is edited without re-review) makes the check
 * STALE and keeps the submission out of the fast lane until the review is re-run.
 */
export function impersonationFingerprint(input: ImpersonationFingerprintInput): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require('crypto') as typeof Crypto;
  const canonical = JSON.stringify([
    input.name,
    input.slug,
    input.tagline ?? null,
    input.description ?? null,
    input.iconId ?? null,
    input.coverId ?? null,
  ]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
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
