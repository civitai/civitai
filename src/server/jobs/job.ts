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
