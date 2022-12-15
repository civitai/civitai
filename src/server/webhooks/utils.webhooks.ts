import { modelWebhooks } from '~/server/webhooks/model.webooks';

export const webhookProcessors = {
  ...modelWebhooks,
};

export function getWebhookTypes() {
  const webhookTypes: Record<string, string> = {};
  for (const [type, { displayName }] of Object.entries(webhookProcessors)) {
    webhookTypes[type] = displayName;
  }
  return webhookTypes;
}
