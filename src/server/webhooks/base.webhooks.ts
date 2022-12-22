import { PrismaClient } from '@prisma/client';

type WebhookProcessor = {
  displayName: string;
  moderatorOnly?: boolean;
  getData: (context: WebhookProcessorRunContext) => Promise<MixedObject[]>;
};

export type WebhookProcessorRunContext = {
  lastSent: string;
  prisma: PrismaClient;
};

export function createWebhookProcessor(processor: Record<string, WebhookProcessor>) {
  return processor;
}
