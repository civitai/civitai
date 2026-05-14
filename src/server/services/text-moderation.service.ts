import { dbWrite } from '~/server/db/client';
import { createXGuardModerationRequest } from '~/server/services/orchestrator/orchestrator.service';
import {
  hashContent,
  upsertEntityModerationPending,
} from '~/server/services/entity-moderation.service';
import { EntityModerationStatus } from '~/shared/utils/prisma/enums';
import type { Priority } from '@civitai/client';

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
  const contentHash = hashContent(content);

  // Persist the Pending row BEFORE calling the orchestrator so a silent
  // orchestrator failure (createXGuardModerationRequest returns undefined) still
  // leaves a retry candidate for `retry-failed-text-moderation`. Without this,
  // a failed submit produced no DB row and the article was trapped forever.
  await upsertEntityModerationPending({
    entityType,
    entityId,
    workflowId: null,
    contentHash,
  });

  const workflow = await createXGuardModerationRequest({
    mode: 'text',
    entityType,
    entityId,
    content,
    labels,
    priority,
    wait,
    recordForReview,
  });

  if (workflow?.id) {
    // Guarded on status: 'Pending' so a webhook that raced ahead of us and
    // already flipped the row to Succeeded isn't clobbered.
    await dbWrite.entityModeration.updateMany({
      where: { entityType, entityId, status: EntityModerationStatus.Pending },
      data: { workflowId: workflow.id },
    });
  }

  return workflow;
}
