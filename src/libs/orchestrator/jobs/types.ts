export enum JobStatus {
  Initialized = 'Initialized',
  Claimed = 'Claimed',
  Updated = 'Updated',
  Succeeded = 'Succeeded',
  Failed = 'Failed',
  Rejected = 'Rejected',
  LateRejected = 'LateRejected',
  Deleted = 'Deleted',
  Canceled = 'Canceled',
  Expired = 'Expired',
  ClaimExpired = 'ClaimExpired',
}

export enum JobType {
  TextToImage = 'TextToImage',
}

export type TimeSpan = {
  ticks?: number;
  readonly days?: number;
  readonly hours?: number;
  readonly milliseconds?: number;
  readonly microseconds?: number;
  readonly nanoseconds?: number;
  readonly minutes?: number;
  readonly seconds?: number;
  readonly totalDays?: number;
  readonly totalHours?: number;
  readonly totalMilliseconds?: number;
  readonly totalMicroseconds?: number;
  readonly totalNanoseconds?: number;
  readonly totalMinutes?: number;
  readonly totalSeconds?: number;
};
