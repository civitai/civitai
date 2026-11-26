import type { ModerationAdapter } from '~/server/services/entity-moderation.service';
import { autoMuteScamAccount } from '~/server/services/scam-auto-mute.service';
import type { ScamCleanup } from '~/server/services/scam-cleanup.service';
import { withCsamHold } from '~/server/services/text-scan/actions/csam-hold';
import { createTextScanAdapter } from '~/server/services/text-scan/adapter';
import { scamSubjectText } from '~/server/services/text-scan/profiles/scam-text';
import type { TextScanOutcome, TextScanSubject } from '~/server/services/text-scan/types';

export const SCAM_ENTITY_TYPES = [
  'ChatMessage',
  'CommentV3',
  'ResourceReview',
  'User',
  'UserProfile',
] as const;
export type ScamEntityType = (typeof SCAM_ENTITY_TYPES)[number];
export const SCAM_TRIGGER_TEXT_CHARS = 2000;

const SCAM_CLEANUP: Record<ScamEntityType, ScamCleanup> = {
  ChatMessage: 'chatMessages',
  CommentV3: 'comments',
  ResourceReview: 'none',
  User: 'none',
  UserProfile: 'none',
};

function contentAtOf(subject: TextScanSubject) {
  const value = subject.meta?.contentAt;
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function applyScamVerdict(
  entityType: ScamEntityType,
  {
    entityId,
    workflowId,
    outcome,
    subject,
    textHash,
  }: {
    entityId: number;
    workflowId: string;
    outcome: TextScanOutcome;
    subject: TextScanSubject;
    textHash: string;
  }
) {
  if (!outcome.scam?.detected) return;
  const userId = subject.userId;
  if (!userId || userId <= 0) return;

  await autoMuteScamAccount({
    userId,
    cleanup: SCAM_CLEANUP[entityType],
    ignoreAccountAge: entityType === 'User',
    evidence: {
      source: `text-scan:${entityType}:${entityId}`,
      dedupeKey: workflowId,
      reason: outcome.scam.reason,
      entityType,
      entityId,
      text: scamSubjectText(subject).slice(0, SCAM_TRIGGER_TEXT_CHARS),
      textHash,
      contentAt: contentAtOf(subject),
    },
  });
}

type ApplyArgs = Parameters<typeof applyScamVerdict>[1];
const holdThenScam = (entityType: ScamEntityType) =>
  withCsamHold(entityType, (args) => applyScamVerdict(entityType, args));

/**
 * CommentV3 also hides a flagged Feature Pages comment (other comments keep the site's rules). The
 * hide runs whether the csam hold write or the scam action fails; the scam action still waits on
 * the hold write, and any failure still fails the apply so it is retried.
 */
async function applyCommentV3TextScan(args: ApplyArgs) {
  const steps = [() => holdThenScam('CommentV3')(args)];
  if (args.outcome.scam?.detected || args.outcome.csam?.detected)
    steps.unshift(async () => {
      const { hideFlaggedFpComment } = await import(
        '~/server/services/commentv3/moderation.service'
      );
      await hideFlaggedFpComment(args.entityId, { textHash: args.textHash });
    });
  const failed = (await Promise.allSettled(steps.map((step) => step()))).find(
    (r): r is PromiseRejectedResult => r.status === 'rejected'
  );
  if (failed) throw failed.reason;
}

export const scamModerationAdapters = Object.fromEntries(
  SCAM_ENTITY_TYPES.map((entityType) => [
    entityType,
    createTextScanAdapter(entityType, {
      applyTextScan: entityType === 'CommentV3' ? applyCommentV3TextScan : holdThenScam(entityType),
    }),
  ])
) as Record<ScamEntityType, ModerationAdapter>;
