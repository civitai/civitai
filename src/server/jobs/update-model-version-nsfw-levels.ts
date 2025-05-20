import { dbRead } from '~/server/db/client';
import { createJob, getJobDate } from '~/server/jobs/job';
import { Limiter } from '~/server/utils/concurrency-helpers';
import { updateModelVersionNsfwLevels } from '~/server/services/nsfwLevels.service';

export const updateModelVersionNsfwLevelsJob = createJob(
  'update-model-version-nsfw-levels',
  '*/30 * * * *',
  async () => {
    const [lastApplied, setLastApplied] = await getJobDate('update-model-version-nsfw-levels');
    const lastAppliedCutoff = new Date(lastApplied.setHours(lastApplied.getHours() - 24));

    const modelVersions = await dbRead.modelVersion.findMany({
      where: {
        status: 'Published',
        publishedAt: { gte: lastAppliedCutoff },
        nsfwLevel: 0,
        model: { status: 'Published' },
      },
      select: { id: true },
    });

    await Limiter().process(
      modelVersions.map((x) => x.id),
      (batch) => updateModelVersionNsfwLevels(batch)
    );

    await setLastApplied();
  }
);
