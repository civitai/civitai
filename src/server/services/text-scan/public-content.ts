import type { Prisma } from '@prisma/client';
import { Availability, ModelStatus } from '~/shared/utils/prisma/enums';

// Scheduled counts as public so the verdict exists by the time the content goes live.
export const PUBLIC_MODEL_WHERE = {
  deletedAt: null,
  status: { in: [ModelStatus.Published, ModelStatus.Scheduled] },
  availability: { not: Availability.Private },
} satisfies Prisma.ModelWhereInput;

export const PUBLIC_POST_WHERE = {
  publishedAt: { not: null },
} satisfies Prisma.PostWhereInput;
