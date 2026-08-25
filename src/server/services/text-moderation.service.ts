import { createXGuardModerationRequest } from '~/server/services/orchestrator/orchestrator.service';
import type { XGuardLabelOverride } from '~/server/services/orchestrator/orchestrator.service';
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
  labelOverrides,
  priority,
  wait,
  recordForReview = false,
  forceRescan = false,
}: {
  entityType: string;
  entityId: number;
  content: string;
  labels?: string[];
  /**
   * Per-label policy, threshold and action for this request only. Lets one
   * surface scan under a policy tuned for it; the alternative is editing the
   * global text registry, which every text consumer shares.
   */
  labelOverrides?: XGuardLabelOverride[];
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
    labelOverrides,
    priority,
    wait,
    recordForReview,
    forceRescan,
  });
}
