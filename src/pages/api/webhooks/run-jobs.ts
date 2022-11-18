import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { scanFilesJob } from '~/server/jobs/scan-files';
import { updateMetricsJob } from '~/server/jobs/update-metrics';
import { processImportsJob } from '~/server/jobs/process-imports';
import cronParser from 'cron-parser';
import dayjs from 'dayjs';
import { z } from 'zod';

const jobs = [scanFilesJob, updateMetricsJob, processImportsJob];

export default WebhookEndpoint(async (req, res) => {
  const { run: runJob } = querySchema.parse(req.query);
  const ran = [];
  const toRun = [];
  const afterResponse = [];

  const now = new Date();
  for (const { name, cron, run, options } of jobs) {
    if (runJob) {
      if (runJob !== name) continue;
    } else if (!isCronMatch(cron, now)) continue;

    if (options.shouldWait) {
      await run();
      ran.push(name);
    } else {
      afterResponse.push(run);
      toRun.push(name);
    }
  }

  res.status(200).json({ ok: true, ran, toRun });
  await Promise.all(afterResponse.map((run) => run()));
});

// https://github.com/harrisiirak/cron-parser/issues/153#issuecomment-590099607
const cronScopes = ['minute', 'hour', 'day', 'month', 'weekday'] as const;
function isCronMatch(
  cronExpression: string,
  date: Date,
  scope: typeof cronScopes[number] = 'minute'
): boolean {
  const scopeIndex = cronScopes.indexOf(scope);
  const day = dayjs(date);

  try {
    const { fields } = cronParser.parseExpression(cronExpression);

    if (scopeIndex <= 0 && !(fields.minute as number[]).includes(day.minute())) return false;
    if (scopeIndex <= 1 && !(fields.hour as number[]).includes(day.hour())) return false;
    if (scopeIndex <= 2 && !(fields.dayOfMonth as number[]).includes(day.date())) return false;
    if (scopeIndex <= 3 && !(fields.month as number[]).includes(day.month() + 1)) return false;
    if (scopeIndex <= 4 && !(fields.dayOfWeek as number[]).includes(day.day())) return false;

    return true;
  } catch (e) {
    return false;
  }
}

const querySchema = z.object({
  run: z.string().optional(),
});
