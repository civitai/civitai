import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import {
  contentRatingFromNsfwLevel,
  nsfwBrowsingLevelsFlag,
  type OffsiteRatingValue,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';

/**
 * Custom Generators (Phase-2a PR-C) — the PURE scan-gate decision for the
 * `OPEN_IMAGE_UPLOAD` host bridge, extracted so the security-critical
 * pending/scanned/blocked discriminant + the SFW ceiling are unit-testable in the
 * node vitest env (no Prisma / no dbRead — mirrors pageBlockHostLogic + the
 * catalog-maturity clamp module).
 *
 * The cosmetic background is a PUBLIC image with NO mod review before it renders,
 * so the gate is STRICTER than the app-listing asset gate ({@link loadValidatedImage}
 * deliberately defers content-rating because every listing is mod-approved first):
 * here a scanned image whose rating exceeds the SFW ceiling (PG + PG-13) is
 * REJECTED, not merely rated.
 *
 * Outcomes (a discriminated union so the caller maps each to the right transport):
 *   - `pending`      — scan in-flight (Pending / Error-retry / PendingManualAssignment).
 *                      NON-error; the caller returns `{ status: 'pending' }` and the
 *                      client re-polls.
 *   - `ready`        — Scanned AND within the SFW ceiling AND carrying NO moderation
 *                      flag. Carries the derived `contentRating` (never above `pg13`).
 *   - `blocked-scan` — TERMINAL: the scanner rejected the bytes (prohibited content).
 *   - `blocked-nsfw` — TERMINAL: scanned clean but the content rating is above the
 *                      SFW ceiling (R/X/…). A public cosmetic image may not be mature.
 *   - `blocked-flagged` — TERMINAL: `Scanned` but carrying a moderation flag
 *                      (`needsReview` / `poi` / `minor` / `tosViolation`). Since this
 *                      background is PUBLIC with NO mod review before it renders, a
 *                      flag that would normally be resolved by a human must fail
 *                      closed here — a `Scanned` ingestion does NOT clear these
 *                      (they're set at/after scan without flipping ingestion). Mirrors
 *                      PR-B's `validateGeneratorBackgroundImage` tightening.
 *   - `import-failed`— TERMINAL: the scanner couldn't fetch the bytes (NotFound).
 * The caller THROWS on the four terminal outcomes (client shows the message +
 * stops polling); `pending`/`ready` are non-error 200s.
 */
export type CosmeticImageScanOutcome =
  | { status: 'pending' }
  | { status: 'ready'; contentRating: OffsiteRatingValue }
  | { status: 'blocked-scan' }
  | { status: 'blocked-nsfw'; contentRating: OffsiteRatingValue }
  | { status: 'blocked-flagged' }
  | { status: 'import-failed' };

/**
 * The SFW content ceiling the returned cosmetic image may carry: any level bit
 * outside PG/PG-13 (i.e. intersecting R/X/XXX/Blocked) fails the ceiling. Kept as
 * the canonical `nsfwBrowsingLevelsFlag` intersection so the ceiling can never
 * drift from the rest of the App-Blocks SFW policy (`domainBrowsingCeiling`).
 */
export function isWithinSfwCosmeticCeiling(nsfwLevel: number): boolean {
  // A 0/undetermined level carries no maturity signal → within ceiling. Any bit
  // intersecting the nsfw flags (R and above) is above the SFW ceiling.
  return !Flags.intersects(nsfwLevel, nsfwBrowsingLevelsFlag);
}

/**
 * Pure gate decision for a cosmetic-background image given its scan state. See
 * {@link CosmeticImageScanOutcome}. Fail-closed on maturity: an unknown
 * ingestion state that is not `Scanned` is treated as still-scanning (`pending`),
 * never `ready`.
 */
export function classifyCosmeticImageScan(image: {
  ingestion: ImageIngestionStatus | string;
  nsfwLevel: number;
  /** Moderation flags that a `Scanned` ingestion does NOT clear (see docstring). */
  needsReview?: string | null;
  poi?: boolean | null;
  minor?: boolean | null;
  tosViolation?: boolean | null;
}): CosmeticImageScanOutcome {
  const { ingestion, nsfwLevel, needsReview, poi, minor, tosViolation } = image;

  // TERMINAL scan failures first.
  if (ingestion === ImageIngestionStatus.NotFound) return { status: 'import-failed' };
  if (ingestion === ImageIngestionStatus.Blocked) return { status: 'blocked-scan' };

  // Still scanning — any non-Scanned, non-terminal state is a poll-able pending.
  if (ingestion !== ImageIngestionStatus.Scanned) return { status: 'pending' };

  // Scanned but FLAGGED: a Scanned ingestion does NOT clear needsReview/poi/minor/
  // tosViolation (they're set at/after scan without flipping ingestion). A PUBLIC,
  // un-mod-reviewed background must fail closed on ANY of them.
  if (needsReview != null || poi === true || minor === true || tosViolation === true) {
    return { status: 'blocked-flagged' };
  }

  // Scanned: enforce the SFW ceiling on a PUBLIC cosmetic image.
  const contentRating = contentRatingFromNsfwLevel(nsfwLevel);
  if (!isWithinSfwCosmeticCeiling(nsfwLevel)) return { status: 'blocked-nsfw', contentRating };

  return { status: 'ready', contentRating };
}
