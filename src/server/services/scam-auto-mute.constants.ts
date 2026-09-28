export const SCAM_AUTO_MUTE_MAX_ACCOUNT_AGE_DAYS = 7;

// `+ 1`: the service skips on `diff(createdAt, 'day') > MAX`, so an account stays eligible until it
// is MAX + 1 whole days old.
export function scamAccountAgeCutoff(now = new Date()) {
  return new Date(now.getTime() - (SCAM_AUTO_MUTE_MAX_ACCOUNT_AGE_DAYS + 1) * 86_400_000);
}
