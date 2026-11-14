import { createHash, randomBytes } from 'node:crypto';

/**
 * A review batch: a set of site image ids an agent hands a moderator for the phone review sheet. The
 * main app mints one into sys Redis; the moderator app signs the sheet in to it and serves it. Server
 * only.
 */

export type ReviewTier = 'general' | 'held';
export const REVIEW_TIERS: readonly ReviewTier[] = ['general', 'held'];

export const REVIEW_BATCH_MAX_IDS = 50;

/** The ModActivity `activity` for general-tier bytes served from byte 0; the routing-miss job reads
 *  these rows back. */
export const REVIEW_SERVED_ACTIVITY = 'review-media-served';
export const REVIEW_BATCH_TTL_SECONDS = 24 * 60 * 60;

export type ReviewBatchRecord = {
  ids: number[];
  tier: ReviewTier;
  /** The batch was declared suspect, by its minter or by its source text. */
  declared: boolean;
  viewer: number;
  createdBy: number;
  /** The minting API key, so revoking the key can find every batch it minted. */
  keyId: number;
  seat: string | null;
  createdAt: number;
};

/** 16 random bytes, 22 base64url characters. */
export const newReviewBatchId = () => randomBytes(16).toString('base64url');
const BATCH_ID = /^[A-Za-z0-9_-]{22}$/;
export const isReviewBatchId = (value: string) => BATCH_ID.test(value);

/** The `contentHash` an image's scan rows are written under in ClickHouse `scanner_label_results`. */
export const imageAuditContentHash = (imageId: number) =>
  createHash('sha256').update(`image:${imageId}`, 'utf8').digest('hex').slice(0, 16);

/**
 * Per image, whether its scanner rows mark CSAM or a minor, or cannot show it does not. The audit
 * write is best-effort and lands after the verdict, so an image with no rows at all is unreadable,
 * never clean. Every scan writes at least its `nsfw_level` row.
 */
export const SCANNER_HITS_SQL = `
  SELECT contentHash, max(label IN ('csam', 'minor') AND triggered = 1) AS hit
  FROM scanner_label_results
  WHERE contentHash IN {hashes:Array(String)}
  GROUP BY contentHash
`;
export function scannerHeldIds(
  ids: readonly number[],
  rows: readonly { contentHash: string; hit: number | boolean | string }[]
): Set<number> {
  const byHash = new Map(
    rows.map((row) => [row.contentHash, Number(row.hit) === 1 || row.hit === true])
  );
  return new Set(ids.filter((id) => byHash.get(imageAuditContentHash(id)) !== false));
}

/** What Redis stores in place of the id, which is the link's only secret. */
export const reviewBatchHash = (batchId: string) =>
  createHash('sha256').update(batchId).digest('base64url');

export const REVIEW_MEDIA_ORIGIN = 'https://moderator.civitai.com';
export const reviewBatchLink = (tier: ReviewTier, batchId: string, origin = REVIEW_MEDIA_ORIGIN) =>
  `${origin}/api/${tier === 'held' ? 'held' : 'review'}-media/b/${batchId}`;

export function parseReviewBatchRecord(raw: string | null | undefined): ReviewBatchRecord | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ReviewBatchRecord>;
    const ids = value.ids;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > REVIEW_BATCH_MAX_IDS ||
      !ids.every((id) => Number.isSafeInteger(id) && id > 0) ||
      !REVIEW_TIERS.includes(value.tier as ReviewTier) ||
      typeof value.declared !== 'boolean' ||
      !Number.isSafeInteger(value.viewer) ||
      !Number.isSafeInteger(value.createdBy) ||
      !Number.isSafeInteger(value.keyId) ||
      typeof value.createdAt !== 'number'
    )
      return null;
    return value as ReviewBatchRecord;
  } catch {
    return null;
  }
}

/**
 * The form both the hub and this server match text in: NFKC, invisible characters (zero-width
 * spaces and joiners, soft hyphens) removed so they cannot split a word, lower-cased, every run of
 * characters that is not alphabetic or numeric collapsed to one space, trimmed. The hub implements
 * the same steps in this order; a difference lets a term through one side.
 */
export const normalizeReviewText = (text: string) =>
  text
    .normalize('NFKC')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .toLowerCase()
    .replace(/[^\p{Alphabetic}\p{N}]+/gu, ' ')
    .trim();

/** The private suspect-term list, one term or phrase per line. Null when absent or empty, which the
 *  mint treats as every batch declared. */
export function parseSuspectTerms(raw: string | null | undefined): string[] | null {
  const terms = (raw ?? '')
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .map(normalizeReviewText)
    .filter(Boolean);
  return terms.length ? [...new Set(terms)] : null;
}

/** Whether any text contains a term as a whole word or phrase. */
export function matchesSuspectTerm(texts: readonly string[], terms: readonly string[]): boolean {
  const padded = texts.map((text) => ` ${normalizeReviewText(text)} `);
  return terms.some((term) => padded.some((text) => text.includes(` ${term} `)));
}

export type BlockedForPatterns = { signal: RegExp[]; nonMinor: RegExp[] };

const ALWAYS_NON_MINOR = new Set(['moderated', 'tos', 'ainotverified']);

/**
 * The private `Image.blockedFor` patterns: regex lines under a `# signal` or `# known-non-minor`
 * header; other `#` lines are comments. Null when absent, when a pattern sits under no header, or
 * when one does not compile: the caller then reads every non-trivial value as a signal.
 */
export function parseBlockedForPatterns(raw: string | null | undefined): BlockedForPatterns | null {
  if (!raw?.trim()) return null;
  const patterns: BlockedForPatterns = { signal: [], nonMinor: [] };
  let section: RegExp[] | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    if (text === '# signal') section = patterns.signal;
    else if (text === '# known-non-minor') section = patterns.nonMinor;
    else if (text.startsWith('#')) continue;
    else if (!section) return null;
    else
      try {
        section.push(new RegExp(text, 'u'));
      } catch {
        return null;
      }
  }
  return patterns.signal.length || patterns.nonMinor.length ? patterns : null;
}

/** One image's Postgres signals: `suspectImageSql` and `unreadableImageSql`, and its raw blockedFor. */
export type ImageSignalRow = {
  id: number;
  suspect: boolean;
  unreadable: boolean;
  blockedFor: string | null;
};

/** Whether an image must go to the held tier. An id with no row cannot be read, so it is held. */
export const imageRoutesHeld = (
  row: ImageSignalRow | undefined,
  patterns: BlockedForPatterns | null
) => !row || row.suspect || row.unreadable || blockedForSignal(row.blockedFor, patterns);

const normalizeBlockedForValue = (value: string) => value.normalize('NFKC').toLowerCase().trim();

/**
 * Whether `Image.blockedFor` is a CSAM or minor signal. It is free text, a comma list of reasons, so
 * the rule is an allowlist: a value is clean only if it is a known non-minor reason or matches a
 * known-non-minor pattern and no signal pattern. Anything else, including any value when the
 * patterns are missing, is a signal.
 */
export function blockedForSignal(
  blockedFor: string | null | undefined,
  patterns: BlockedForPatterns | null
): boolean {
  if (blockedFor == null) return false;
  const values = blockedFor.split(',').map(normalizeBlockedForValue).filter(Boolean);
  if (!values.length) return true;
  return values.some((value) => {
    if (patterns?.signal.some((re) => re.test(value))) return true;
    if (ALWAYS_NON_MINOR.has(value)) return false;
    return !patterns?.nonMinor.some((re) => re.test(value));
  });
}
