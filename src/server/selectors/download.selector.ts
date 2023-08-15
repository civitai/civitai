import { Prisma } from '@prisma/client';

export const getAllDownloadsSelect = Prisma.validator<Prisma.DownloadHistorySelect>()({
  downloadAt: true,
  modelVersion: {
    select: {
      name: true,
      id: true,
      model: {
        select: {
          name: true,
          id: true,
        },
      },
    },
  },
});
