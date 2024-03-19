import { NextApiResponse } from 'next';
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

export type JobStatus = 'running' | 'canceled' | 'finished';
export type JobContext = {
  status: JobStatus;
  on: (event: 'cancel', listener: () => Promise<void>) => void;
  checkIfCanceled: () => void;
};

export function inJobContext(res: NextApiResponse, fn: (jobContext: JobContext) => Promise<void>) {
  const onCancel: (() => Promise<void>)[] = [];
  const jobContext = {
    status: 'running' as JobStatus,
    on: (event: 'cancel', listener: () => Promise<void>) => {
      if (event === 'cancel') onCancel.push(listener);
    },
    checkIfCanceled: () => {
      if (jobContext.status === 'canceled') throw new Error('Job was canceled');
    },
  };
  res.on('close', async () => {
    if (jobContext.status !== 'running') return;
    jobContext.status = 'canceled';
    await Promise.all(onCancel.map((x) => x()));
  });
  return fn(jobContext).finally(() => {
    if (jobContext.status !== 'running') return;
    jobContext.status = 'finished';
  });
}

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
        status: 'running' as JobStatus,
        on: (event: 'cancel', listener: () => Promise<void>) => {
          if (event === 'cancel') onCancel.push(listener);
        },
        checkIfCanceled: () => {
          if (jobContext.status !== 'running') throw new Error('Job has ended');
        },
      };
      const cancel = () => {
        if (jobContext.status !== 'running') return;
        jobContext.status = 'canceled';
        Promise.all(onCancel.map((x) => x()));
      };
      const result = fn(jobContext);
      result.finally(() => {
        if (jobContext.status === 'canceled') return;
        jobContext.status = 'finished';
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
