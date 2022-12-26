import { Prisma } from '@prisma/client';

export const getAllDownloadsSelect = Prisma.validator<Prisma.DownloadHistorySelect>()({
  id: true,
  createdAt: true,
  model: {
    select: {
      name: true,
      id: true,
    },
  },
  modelVersion: {
    select: {
      name: true,
      id: true,
    },
  },
});
