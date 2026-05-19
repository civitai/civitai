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
}: {
  entityType: string;
  entityId: number;
  content: string;
  labels?: string[];
  priority?: Priority;
  wait?: number;
  recordForReview?: boolean;
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
  });
}
