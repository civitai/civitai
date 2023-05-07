import { dbWrite } from '~/server/db/client';

export type Job = {
  name: string;
  run: () => Promise<void>;
  cron: string;
  options: JobOptions;
};

export type JobOptions = {
  shouldWait: boolean;
  lockExpiration: number;
};

export function createJob(
  name: string,
  cron: string,
  fn: () => Promise<void>,
  options: Partial<JobOptions> = {}
) {
  return {
    name,
    cron,
    run: fn,
    options: {
      shouldWait: false,
      lockExpiration: 2 * 60,
      ...options,
    },
  } as Job;
}

export async function getJobDate(key: string, defaultValue?: Date) {
  defaultValue ??= new Date(0);
  const stored = await dbWrite.keyValue.findUnique({ where: { key } });
  const date = stored ? new Date(stored.value as number) : defaultValue;

  const set = async (date?: Date) => {
    date ??= new Date();
    await dbWrite.keyValue.upsert({
      where: { key },
      create: { key, value: date.getTime() },
      update: { value: date.getTime() },
    });
  };

  return [date, set] as const;
}
