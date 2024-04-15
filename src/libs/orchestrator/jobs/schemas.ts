import { JobStatus, JobType } from './types';
import { z } from 'zod';

export const eventSchema = z.object({
  type: z.nativeEnum(JobStatus),
  jobId: z.string(),
  jobType: z.nativeEnum(JobType),
  jobDuration: z.string().nullish(),
  jobHasCompleted: z.boolean(),
  claimDuration: z.string().nullish(),
  claimHasCompleted: z.boolean(),
  workerId: z.string().nullish(),
  dateTime: z.string(),
  retryAttempt: z.number().nullish(),
  cost: z.number().nullish(),
});
