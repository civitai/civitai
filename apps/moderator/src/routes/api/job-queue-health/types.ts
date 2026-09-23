import type { Jsonified } from '$lib/format';
import type { JobQueueHealth } from '$lib/server/job-queue.service';

/** The same payload as the browser receives it — every `Date` has been through JSON. */
export type JobQueueHealthPayload = Jsonified<JobQueueHealth>;
