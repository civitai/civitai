import { dbWrite } from '~/server/db/client';

export type Job = {
  name: string;
  run: () => {
    result: Promise<MixedObject | void>;
    cancel: () => Promise<void>;
  };
  cron: string;
  options: JobOptions;
};

export type JobOptions = {
  shouldWait: boolean;
  lockExpiration: number;
  queue?: string;
  /** restrict job to only run on a single pod */
  dedicated?: boolean;
};

export type JobContext = {
  on: (event: 'cancel', listener: () => Promise<void>) => void;
};

export function createJob(
  name: string,
  cron: string,
  fn: (e: JobContext) => Promise<MixedObject | void>,
  options: Partial<JobOptions> = {}
) {
  return {
    name,
    cron,
    run: () => {
      const onCancel: (() => Promise<void>)[] = [];
      const jobContext = {
        on: (event: 'cancel', listener: () => Promise<void>) => {
          if (event === 'cancel') onCancel.push(listener);
        },
      };
      let running = true;
      const cancel = () => {
        if (!running) return;
        console.log('canceling job');
        Promise.all(onCancel.map((x) => x()));
      };
      const result = fn(jobContext);
      result.finally(() => {
        running = false;
      });
      return { result, cancel };
    },
    options: {
      shouldWait: false,
      lockExpiration: 5 * 60,
      ...options,
    },
  } as Job;
}

export async function getJobDate(key: string, defaultValue?: Date) {
  defaultValue ??= new Date(0);
  const stored = await dbWrite.keyValue.findUnique({ where: { key } });
  const date = stored ? new Date(stored.value as number) : defaultValue;

  const newDate = new Date();
  const set = async (date?: Date) => {
    date ??= newDate;
    await dbWrite.keyValue.upsert({
      where: { key },
      create: { key, value: date.getTime() },
      update: { value: date.getTime() },
    });
  };

  return [date, set] as const;
}

// Set on Feb. 31st which will never come.
export const UNRUNNABLE_JOB_CRON = '0 0 5 31 2 ?';
