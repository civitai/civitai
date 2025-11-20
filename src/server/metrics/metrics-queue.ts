import { addToQueue } from '~/server/redis/queues';

/**
 * Queue updates for specific metrics without importing the metric processors.
 * This prevents circular dependencies between services and metrics.
 */

export async function queueModelMetricUpdate(ids: number | number[]) {
  if (!Array.isArray(ids)) ids = [ids];
  await addToQueue('metric-update:model', ids);
}

export async function queueUserMetricUpdate(ids: number | number[]) {
  if (!Array.isArray(ids)) ids = [ids];
  await addToQueue('metric-update:user', ids);
}

export async function queueImageMetricUpdate(ids: number | number[]) {
  if (!Array.isArray(ids)) ids = [ids];
  await addToQueue('metric-update:image', ids);
}

export async function queuePostMetricUpdate(ids: number | number[]) {
  if (!Array.isArray(ids)) ids = [ids];
  await addToQueue('metric-update:post', ids);
}

export async function queueArticleMetricUpdate(ids: number | number[]) {
  if (!Array.isArray(ids)) ids = [ids];
  await addToQueue('metric-update:article', ids);
}

export async function queueAnswerMetricUpdate(ids: number | number[]) {
  if (!Array.isArray(ids)) ids = [ids];
  await addToQueue('metric-update:answer', ids);
}

export async function queueQuestionMetricUpdate(ids: number | number[]) {
  if (!Array.isArray(ids)) ids = [ids];
  await addToQueue('metric-update:question', ids);
}

export async function queueBountyMetricUpdate(ids: number | number[]) {
  if (!Array.isArray(ids)) ids = [ids];
  await addToQueue('metric-update:bounty', ids);
}

export async function queueBountyEntryMetricUpdate(ids: number | number[]) {
  if (!Array.isArray(ids)) ids = [ids];
  await addToQueue('metric-update:bountyentry', ids);
}

export async function queueClubMetricUpdate(ids: number | number[]) {
  if (!Array.isArray(ids)) ids = [ids];
  await addToQueue('metric-update:club', ids);
}

export async function queueClubPostMetricUpdate(ids: number | number[]) {
  if (!Array.isArray(ids)) ids = [ids];
  await addToQueue('metric-update:clubpost', ids);
}

export async function queueCollectionMetricUpdate(ids: number | number[]) {
  if (!Array.isArray(ids)) ids = [ids];
  await addToQueue('metric-update:collection', ids);
}

export async function queueTagMetricUpdate(ids: number | number[]) {
  if (!Array.isArray(ids)) ids = [ids];
  await addToQueue('metric-update:tag', ids);
}
