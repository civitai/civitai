import { createXGuardModerationRequest } from '~/server/services/orchestrator/orchestrator.service';
import type { Priority } from '@civitai/client';

// EntityModeration upsert is owned by `createXGuardModerationRequest` —
// it persists a Pending row on success and a Failed row on submit failure
// (no workflow id). The retry-failed-text-moderation cron picks Failed rows
// up automatically.
export async function submitTextModeration({
  entityType,
  entityId,
  content,
  labels,
  priority,
  wait,
  recordForReview = false,
  forceRescan = false,
}: {
  entityType: string;
  entityId: number;
  content: string;
  labels?: string[];
  priority?: Priority;
  wait?: number;
  recordForReview?: boolean;
  /**
   * Bypass the contentHash dedup in `createXGuardModerationRequest`. Use
   * for moderator-initiated rescans (`rescanArticle`, etc.) where the
   * previous verdict shouldn't be reused.
   */
  forceRescan?: boolean;
}) {
  return createXGuardModerationRequest({
    mode: 'text',
    entityType,
    entityId,
    content,
    labels,
    priority,
    wait,
    recordForReview,
    forceRescan,
  });
}
