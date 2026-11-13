/**
 * `scheduleIntent`: a date schedules, null cancels, undefined leaves it. The loaded article's own
 * scheduledAt/publishedAt are dropped so a plain save doesn't re-send them. `publishing` can be a
 * stale earlier Publish click, so a schedule submit never publishes.
 */
export function getArticleScheduleSubmit<
  T extends { scheduledAt?: unknown; publishedAt?: unknown }
>(
  values: T,
  { publishing, scheduleIntent }: { publishing: boolean; scheduleIntent: Date | null | undefined }
) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { scheduledAt: _stored, publishedAt: _storedPublishedAt, ...rest } = values;
  return {
    rest,
    scheduledAt: scheduleIntent,
    publishNow: publishing && scheduleIntent === undefined,
  };
}
