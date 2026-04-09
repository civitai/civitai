import { env } from '~/env/server';
import { createTextModerationRequest } from '~/server/services/orchestrator/orchestrator.service';
import {
  hashContent,
  upsertEntityModerationPending,
} from '~/server/services/entity-moderation.service';
import type { Priority } from '@civitai/client';

export async function submitTextModeration({
  entityType,
  entityId,
  content,
  labels,
  priority,
  wait,
}: {
  entityType: string;
  entityId: number;
  content: string;
  labels?: string[];
  priority?: Priority;
  wait?: number;
}) {
  const callbackUrl =
    env.TEXT_MODERATION_CALLBACK ??
    `${env.NEXTAUTH_URL}/api/webhooks/text-moderation-result?token=${env.WEBHOOK_TOKEN}`;

  const workflow = await createTextModerationRequest({
    entityType,
    entityId,
    content,
    labels,
    callbackUrl,
    priority,
    wait,
  });

  if (workflow?.id) {
    await upsertEntityModerationPending({
      entityType,
      entityId,
      workflowId: workflow.id,
      contentHash: hashContent(content),
    });
  }

  return workflow;
}
