import type { ModerationAdapter } from '~/server/services/entity-moderation.service';
import { autoMuteScamAccount } from '~/server/services/scam-auto-mute.service';
import type { ScamCleanup } from '~/server/services/scam-cleanup.service';
import { createTextScanAdapter } from '~/server/services/text-scan/adapter';
import { scamSubjectText } from '~/server/services/text-scan/profiles/scam-text';
import type { TextScanOutcome, TextScanSubject } from '~/server/services/text-scan/types';

export const SCAM_ENTITY_TYPES = [
  'ChatMessage',
  'Comment',
  'CommentV2',
  'ResourceReview',
  'User',
  'UserProfile',
] as const;
export type ScamEntityType = (typeof SCAM_ENTITY_TYPES)[number];
export const SCAM_TRIGGER_TEXT_CHARS = 2000;

const SCAM_CLEANUP: Record<ScamEntityType, ScamCleanup> = {
  ChatMessage: 'chatMessages',
  Comment: 'comments',
  CommentV2: 'commentsV2',
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

export const scamModerationAdapters = Object.fromEntries(
  SCAM_ENTITY_TYPES.map((entityType) => [
    entityType,
    createTextScanAdapter(entityType, {
      applyTextScan: (args) => applyScamVerdict(entityType, args),
    }),
  ])
) as Record<ScamEntityType, ModerationAdapter>;
