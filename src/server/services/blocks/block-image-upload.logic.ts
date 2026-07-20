import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import {
  contentRatingFromNsfwLevel,
  nsfwBrowsingLevelsFlag,
  type OffsiteRatingValue,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';

/**
 * App Blocks (Phase-2a PR-C) — the PURE scan-gate decision for the host-mediated
 * `OPEN_IMAGE_UPLOAD` block image-upload bridge, extracted so the security-critical
 * pending/scanned/blocked discriminant + the SFW ceiling are unit-testable in the
 * node vitest env (no Prisma / no dbRead — mirrors pageBlockHostLogic + the
 * catalog-maturity clamp module).
 *
 * The uploaded image is a user-contributed image a sandboxed block will display
 * PUBLICLY with NO mod review before it renders — the app decides what it is for
 * (avatar / cover / background / reference / …); the platform only guarantees a
 * MODERATED image. So the gate is STRICTER than the app-listing asset gate
 * ({@link loadValidatedImage} defers content-rating because every listing is
 * mod-approved first): here a scanned image that is above the SFW ceiling (PG +
 * PG-13) or carries any moderation flag is REJECTED, not merely rated.
 *
 * Outcomes (a discriminated union so the caller maps each to the right transport):
 *   - `pending`      — scan in-flight (Pending / Error-retry / PendingManualAssignment).
 *                      NON-error; the caller returns `{ status: 'pending' }` and the
 *                      client re-polls.
 *   - `ready`        — Scanned AND within the SFW ceiling AND carrying NO moderation
 *                      flag. Carries the derived `contentRating` (never above `pg13`).
 *   - `blocked-scan` — TERMINAL: the scanner rejected the bytes (prohibited content).
 *   - `blocked-nsfw` — TERMINAL: scanned clean but the content rating is above the
 *                      SFW ceiling (R/X/…). A public block image may not be mature.
 *   - `blocked-flagged` — TERMINAL: `Scanned` but carrying a moderation flag
 *                      (`needsReview` / `poi` / `minor` / `tosViolation`). Since this
 *                      image is PUBLIC with NO mod review before it renders, a flag
 *                      that would normally be resolved by a human must fail closed
 *                      here — a `Scanned` ingestion does NOT clear these (they're set
 *                      at/after scan without flipping ingestion).
 *   - `import-failed`— TERMINAL: the scanner couldn't fetch the bytes (NotFound).
 * The caller THROWS on the four terminal outcomes (client shows the message +
 * stops polling); `pending`/`ready` are non-error 200s.
 */
export type BlockImageUploadScanOutcome =
  | { status: 'pending' }
  | { status: 'ready'; contentRating: OffsiteRatingValue }
  | { status: 'blocked-scan' }
  | { status: 'blocked-nsfw'; contentRating: OffsiteRatingValue }
  | { status: 'blocked-flagged' }
  | { status: 'import-failed' };

/**
 * The SFW content ceiling the returned image may carry: any level bit outside
 * PG/PG-13 (i.e. intersecting R/X/XXX/Blocked) fails the ceiling. Kept as the
 * canonical `nsfwBrowsingLevelsFlag` intersection so the ceiling can never drift
 * from the rest of the App-Blocks SFW policy (`domainBrowsingCeiling`).
 */
export function isWithinSfwImageCeiling(nsfwLevel: number): boolean {
  // A 0/undetermined level carries no maturity signal → within ceiling. Any bit
  // intersecting the nsfw flags (R and above) is above the SFW ceiling.
  return !Flags.intersects(nsfwLevel, nsfwBrowsingLevelsFlag);
}

/**
 * Pure gate decision for a block-uploaded image given its scan state. See
 * {@link BlockImageUploadScanOutcome}. Fail-closed on maturity: an unknown
 * ingestion state that is not `Scanned` is treated as still-scanning (`pending`),
 * never `ready`.
 */
export function classifyBlockImageUploadScan(image: {
  ingestion: ImageIngestionStatus | string;
  nsfwLevel: number;
  /** Moderation flags that a `Scanned` ingestion does NOT clear (see docstring). */
  needsReview?: string | null;
  poi?: boolean | null;
  minor?: boolean | null;
  tosViolation?: boolean | null;
}): BlockImageUploadScanOutcome {
  const { ingestion, nsfwLevel, needsReview, poi, minor, tosViolation } = image;

  // TERMINAL scan failures first.
  if (ingestion === ImageIngestionStatus.NotFound) return { status: 'import-failed' };
  if (ingestion === ImageIngestionStatus.Blocked) return { status: 'blocked-scan' };

  // Still scanning — any non-Scanned, non-terminal state is a poll-able pending.
  if (ingestion !== ImageIngestionStatus.Scanned) return { status: 'pending' };

  // Scanned but FLAGGED: a Scanned ingestion does NOT clear needsReview/poi/minor/
  // tosViolation (they're set at/after scan without flipping ingestion). A PUBLIC,
  // un-mod-reviewed image must fail closed on ANY of them.
  if (needsReview != null || poi === true || minor === true || tosViolation === true) {
    return { status: 'blocked-flagged' };
  }

  // Scanned: enforce the SFW ceiling on a PUBLIC block image.
  const contentRating = contentRatingFromNsfwLevel(nsfwLevel);
  if (!isWithinSfwImageCeiling(nsfwLevel)) return { status: 'blocked-nsfw', contentRating };

  return { status: 'ready', contentRating };
}

// Civitai-controlled image hosts. A workflow OUTPUT blob resolves to an
// `https://orchestration…civitai.com` url (the same bound the vetted
// `blockSourceImageSchema` in workflow.schema.ts applies to SOURCE images) — NOT
// the `ORCHESTRATOR_ENDPOINT` API host, which is an internal cluster service
// whose registrable domain (e.g. `cluster.local`) does not cover the public blob
// / media-CDN host and so rejected every real output. Bounded by parsed HOSTNAME
// (not substring) so userinfo / host-confusion tricks are rejected.
const CIVITAI_OUTPUT_IMAGE_HOSTS = ['civitai.com', 'civitai.red', 'civitai.green'] as const;

/**
 * SSRF allowlist for a workflow output url. The url is server-resolved from the
 * ownership-verified workflow (the block never supplies it), so the realistic
 * threat is only a compromised/misbehaving orchestrator response — but we still
 * gate defensively: HTTPS only, on a Civitai-controlled image host (+ subdomains),
 * matched by parsed hostname.
 */
export function isAllowedOutputHost(rawUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  return CIVITAI_OUTPUT_IMAGE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}
