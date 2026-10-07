import { logToAxiom } from '~/server/logging/client';

/**
 * One Axiom event (`name: 'scan-verdict'`) per finished verdict from every text-moderation system,
 * so text scan's shadow verdicts can be compared offline with what the existing systems decided for
 * the same entity. Fields are fixed and flat, and no user text is logged: whoever analyses the
 * events reads the text from the entity itself. The profanity filter is not logged; its verdict
 * is already stored as `profanityEvaluation` on `Model.meta` and `Bounty.details`.
 */
export type VerdictSystem = 'text-scan' | 'xguard' | 'clavata';

export type ScanVerdict = {
  system: VerdictSystem;
  /** The scanned entity's type, never a `:shadow` row key. */
  entityType: string;
  entityId: number;
  userId?: number;
  /** The system objected to something. */
  flagged: boolean;
  /** The verdict changed something live (a rating, a report, a block, a mute). */
  acted: boolean;
  nsfwLevel?: number | null;
  declaredNsfwLevel?: number | null;
  poi?: boolean;
  minor?: boolean;
  scam?: boolean;
  blocked?: boolean;
  /** The system's own labels: XGuard triggered labels, Clavata matches, text scan triggered labels. */
  tags?: string[];
  mode?: 'shadow' | 'active';
  textHash?: string;
  workflowId?: string;
};

export function logScanVerdict({ tags, ...verdict }: ScanVerdict) {
  return logToAxiom({
    name: 'scan-verdict',
    type: 'info',
    message: `${verdict.system} ${verdict.entityType} ${verdict.entityId}`,
    ...verdict,
    // One string field, so a new label can't add an Axiom column.
    tags: tags?.join(','),
  }).catch(() => undefined);
}

/** `acted` here means the verdict reached the entity's adapter, which may still decline to apply it. */
export function xguardVerdict(v: {
  entityType: string;
  entityId: number;
  workflowId: string;
  blocked: boolean;
  triggeredLabels: string[];
  hasAdapter: boolean;
}): ScanVerdict {
  const flagged = v.blocked || v.triggeredLabels.length > 0;
  return {
    system: 'xguard',
    entityType: v.entityType,
    entityId: v.entityId,
    workflowId: v.workflowId,
    flagged,
    acted: flagged && v.hasAdapter,
    blocked: v.blocked,
    tags: v.triggeredLabels,
  };
}

/** A Clavata result the job drops (clean, or an NSFW-only match outside Model and Bounty) is not acted on. */
export function clavataVerdict(v: {
  entityType: string;
  entityId: number;
  userId: number;
  result: string | undefined;
  matches: string[] | undefined;
  skipped: boolean;
}): ScanVerdict {
  return {
    system: 'clavata',
    entityType: v.entityType,
    entityId: v.entityId,
    userId: v.userId > 0 ? v.userId : undefined,
    flagged: v.result !== 'FALSE',
    acted: !v.skipped,
    tags: v.matches ?? [],
  };
}
