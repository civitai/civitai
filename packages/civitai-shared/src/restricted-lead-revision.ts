import { createHash } from 'node:crypto';

/**
 * What a moderator's screen shows of a restricted-verdict lead, and what a ruling on it branches on.
 * The moderator app hashes it from the row it renders and the main app from the row it locks, so a
 * ruling sent from a screen that no longer matches is refused. Server-side only.
 */
export type RestrictedLeadRevisionInput = {
  lead: {
    at: string | null;
    source: string | null;
    restriction: string | null;
    liftedBy: string | null;
    appliedAt: string | null;
  };
  /** The newest ruling's `at`, by position: rulings are appended, and trimmed from the front. */
  lastRulingAt: string | null;
  model: {
    minor: boolean;
    poi: boolean;
    isPrivate: boolean;
    nsfw: boolean;
    sfwOnly: boolean;
    locks: string[];
    systemNsfwLockAt: string | null;
  };
  /** The scan as the screen shows it: its EntityModeration row and the stored forensics time. */
  scan: {
    nsfwLevel: number | null;
    triggeredLabels: string[];
    nsfwReason: string | null;
    contentHash: string | null;
    forensicsScannedAt: string | null;
  };
};

export function restrictedLeadRevision({
  lead,
  lastRulingAt,
  model,
  scan,
}: RestrictedLeadRevisionInput): string {
  // A fixed order, so neither side's key order or row shape can change the hash.
  const canonical = [
    lead.at,
    lead.source,
    lead.restriction,
    lead.liftedBy,
    lead.appliedAt,
    lastRulingAt,
    model.minor,
    model.poi,
    model.isPrivate,
    model.nsfw,
    model.sfwOnly,
    [...model.locks].sort(),
    model.systemNsfwLockAt,
    scan.nsfwLevel,
    [...scan.triggeredLabels].sort(),
    scan.nsfwReason,
    scan.contentHash,
    scan.forensicsScannedAt,
  ];
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
