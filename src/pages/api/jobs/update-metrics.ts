import { MetricTimeframe, Prisma, UserActivityType } from '@prisma/client';
import { JobEndpoint } from '~/server/common/jobs';

const timeframeDaysMap: Record<MetricTimeframe, number> = {
  [MetricTimeframe.Day]: 1,
  [MetricTimeframe.Week]: 7,
  [MetricTimeframe.Month]: 30,
  [MetricTimeframe.Year]: 365,
  [MetricTimeframe.AllTime]: 365 * 10,
};

const METRIC_LAST_UPDATED_KEY = 'last-metrics-update';

export default JobEndpoint(async (req, res) => {
  // Get the last time this ran from the KeyValue store
  // --------------------------------------
  const lastUpdate = new Date(
    ((
      await prisma?.keyValue.findUnique({
        where: { key: METRIC_LAST_UPDATED_KEY },
      })
    )?.value as number) ?? 0
  );

  // Get all user activities that have happened since then that affect metrics
  // --------------------------------------
  const recentActivities =
    (await prisma?.userActivity.findMany({
      where: {
        createdAt: { gte: lastUpdate },
        activity: { in: [UserActivityType.ModelDownload] },
      },
      select: {
        activity: true,
        details: true,
      },
    })) ?? [];

  // Get all reviews that have been created/updated since then
  // --------------------------------------
  const recentReviews =
    (await prisma?.review.findMany({
      where: {
        OR: [
          { createdAt: { gte: new Date(lastUpdate) } },
          { updatedAt: { gte: new Date(lastUpdate) } },
        ],
      },
      select: {
        modelId: true,
        modelVersionId: true,
      },
    })) ?? [];

  // Get all affected models and versions
  // -------------------------------------
  const affectedModels = new Set<number>();
  const affectedVersions = new Set<number>();
  for (const review of recentReviews) {
    affectedModels.add(review.modelId);
    if (review.modelVersionId) affectedVersions.add(review.modelVersionId);
  }
  for (const activities of recentActivities) {
    const details = activities.details as Prisma.JsonObject;
    if (details?.modelId) affectedModels.add(details.modelId as number);
    if (details?.modelVersionId) affectedVersions.add(details.modelVersionId as number);
  }

  // Get all activities for the affected models and versions
  // ---------------------------------------------------------
  // TODO Optimization: Grab just affected models/versions instead of all of them when computing metrics
  const modelActivities =
    (await prisma?.userActivity.findMany({
      where: {
        activity: { in: [UserActivityType.ModelDownload] },
      },
      select: {
        activity: true,
        details: true,
        createdAt: true,
      },
    })) ?? [];

  const modelReviews =
    (await prisma?.review.findMany({
      where: {
        modelId: { in: [...affectedModels] },
      },
      select: {
        modelId: true,
        modelVersionId: true,
        rating: true,
        createdAt: true,
      },
    })) ?? [];

  // Set up updating functions
  // --------------------------------------------
  const updateModelMetrics = async (timeframe: MetricTimeframe) => {
    // Get the date 24 hours ago
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - timeframeDaysMap[timeframe]);

    // Update the metrics for each affected model
    for (const modelId of affectedModels) {
      const timeframe = MetricTimeframe.Day;

      // Compute download metrics
      const modelActivity = modelActivities.filter((a) => {
        if (a.createdAt < sinceDate) return false;

        const details = a.details as Prisma.JsonObject;
        return details?.modelId === modelId;
      });
      const downloadCount = modelActivity.length;

      // Compute rating metrics
      const modelReview = modelReviews.filter(
        (r) => r.createdAt > sinceDate && r.modelId === modelId
      );
      const ratingCount = modelReview.length;
      const rating =
        modelReview.length === 0
          ? 0
          : Math.round(modelReview.reduce((a, b) => a + b.rating, 0) / ratingCount);

      // Upsert the metric
      await prisma?.modelMetric.upsert({
        where: {
          modelId_timeframe: { modelId, timeframe },
        },
        create: {
          modelId,
          timeframe,
          downloadCount,
          ratingCount,
          rating,
        },
        update: {
          downloadCount,
          ratingCount,
          rating,
        },
      });
    }
  };

  const updateModelVersionMetrics = async (timeframe: MetricTimeframe) => {
    // Get the date 24 hours ago
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - timeframeDaysMap[timeframe]);

    // Update the metrics for each affected version
    for (const modelVersionId of affectedVersions) {
      const timeframe = MetricTimeframe.Day;

      // Compute download metrics
      const modelActivity = modelActivities.filter((a) => {
        if (a.createdAt < sinceDate) return false;

        const details = a.details as Prisma.JsonObject;
        return details?.modelVersionId === modelVersionId;
      });
      const downloadCount = modelActivity.length;

      // Compute rating metrics
      const modelReview = modelReviews.filter(
        (r) => r.createdAt > sinceDate && r.modelVersionId === modelVersionId
      );
      const ratingCount = modelReview.length;
      const rating =
        modelReview.length === 0
          ? 0
          : Math.round(modelReview.reduce((a, b) => a + b.rating, 0) / ratingCount);

      // Upsert the metric
      await prisma?.modelVersionMetric.upsert({
        where: {
          modelVersionId_timeframe: { modelVersionId, timeframe },
        },
        create: {
          modelVersionId,
          timeframe,
          downloadCount,
          ratingCount,
          rating,
        },
        update: {
          downloadCount,
          ratingCount,
          rating,
        },
      });
    }
  };

  // If this is the first metric update of the day, reset the day metrics
  // -------------------------------------------------------------------
  if (lastUpdate.getDate() !== new Date().getDate()) {
    await prisma?.modelMetric.updateMany({
      where: { timeframe: MetricTimeframe.Day },
      data: {
        downloadCount: 0,
        ratingCount: 0,
        rating: 0,
      },
    });
  }

  // Update all affected metrics in each timeframe
  // --------------------------------------------
  for (const timeframe of Object.keys(MetricTimeframe)) {
    await updateModelMetrics(timeframe as MetricTimeframe);
    await updateModelVersionMetrics(timeframe as MetricTimeframe);
  }

  // Update the last update time
  // --------------------------------------------
  await prisma?.keyValue.upsert({
    where: { key: METRIC_LAST_UPDATED_KEY },
    create: { key: METRIC_LAST_UPDATED_KEY, value: new Date().getTime() },
    update: { value: new Date().getTime() },
  });

  res.status(200).json({ ok: true });
});
