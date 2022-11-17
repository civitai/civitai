export type Job = {
  name: string;
  run: () => Promise<void>;
  cron: string;
  options: JobOptions;
};

export type JobOptions = {
  shouldWait?: boolean;
};

export function createJob(
  name: string,
  cron: string,
  fn: () => Promise<void>,
  options: JobOptions = {}
) {
  return {
    name,
    cron,
    run: fn,
    options: {
      shouldWait: true,
      ...options,
    },
  } as Job;
}
