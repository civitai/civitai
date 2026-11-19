// The `retry-failed-text-moderation` job's limits, apart from the job so a service can read them
// without importing the job and every moderation adapter it reaches.
export const TEXT_MODERATION_PENDING_TIMEOUT_MINUTES = 30; // 30 min for stuck Pending rows
export const TEXT_MODERATION_RETRY_LIMIT = 9;
