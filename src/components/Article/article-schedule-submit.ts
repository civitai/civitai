/**
 * What one editor submit asks of the article's schedule.
 *
 * `scheduleIntent` is what the Schedule / Cancel controls set for this submit: a date schedules,
 * null cancels, undefined leaves the stored schedule alone. The form is seeded from the loaded
 * article, so its own `scheduledAt` and `publishedAt` are the stored values and are never sent
 * back; otherwise every save would re-submit the stored schedule. `publishing` is the editor's
 * state and may still hold an earlier Publish click, so a schedule submit never publishes.
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
