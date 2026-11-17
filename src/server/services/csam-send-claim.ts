/**
 * How long a send run's claim on a report holds. Longer than the send job's lock, so a run that
 * still holds the lock never loses its report to the next run.
 */
export const CSAM_SEND_CLAIM_EXPIRY_SECONDS = 5 * 60 * 60;

/** A claim taken before this time has expired: another run may take the report, and a filing fold into it. */
export const csamSendClaimCutoff = () =>
  new Date(Date.now() - CSAM_SEND_CLAIM_EXPIRY_SECONDS * 1000);
