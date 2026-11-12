export const HOLD_REASON_MIN = 10;
export const HOLD_REASON_MAX = 2000;
export const HOLD_LABEL_MAX = 80;
export const MAX_OPEN_HOLDS_PER_APP = 20;
export const APPROVE_CLAIM_TTL_MINUTES = 15;

export const PUBLISH_REQUEST_HOLD_KINDS = ['onsite', 'listing'] as const;
export type PublishRequestHoldKind = (typeof PUBLISH_REQUEST_HOLD_KINDS)[number];
