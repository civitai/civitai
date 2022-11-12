export type Job = {
  name: string;
  run: () => Promise<void>;
  cron: string;
};

export function createJob(name: string, cron: string, fn: () => Promise<void>) {
  return {
    name,
    cron,
    run: fn,
  } as Job;
}
