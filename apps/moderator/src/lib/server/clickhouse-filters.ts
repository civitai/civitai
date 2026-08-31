// Filters shared by every ClickHouse query that reads request-level events.
//
// Declared once because a divergence here fails silently in the worst direction: a copy that misses an
// updated internal range starts counting our own infrastructure as user signal, so a vote-ring panel
// reports clusters made of Civitai traffic and nothing anywhere errors.
export const INTERNAL_IP_RANGE = '10.124.0.0/16';

/** Interpolated into ClickHouse queries, which do NO escaping — every IP must match this first. */
export const IP_PATTERN = /^[0-9a-fA-F.:]{3,45}$/;
