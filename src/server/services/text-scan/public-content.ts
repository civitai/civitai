import type { Prisma } from '@prisma/client';
import { ModelStatus } from '~/shared/utils/prisma/enums';

// Scheduled counts as public so the verdict exists by the time the content goes live. Private
// models count too: generation can use them, and its real-person guard reads `Model.poi`.
const PUBLIC_MODEL_STATUSES: ModelStatus[] = [ModelStatus.Published, ModelStatus.Scheduled];

export const PUBLIC_MODEL_WHERE = {
  deletedAt: null,
  status: { in: PUBLIC_MODEL_STATUSES },
} satisfies Prisma.ModelWhereInput;

export function isPublicModelStatus(status: ModelStatus) {
  return PUBLIC_MODEL_STATUSES.includes(status);
}
