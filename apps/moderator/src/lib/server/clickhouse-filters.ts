// Filters shared by every ClickHouse query that reads request-level events.
//
// Declared once because a divergence here fails silently in the worst direction: a copy that misses an
// updated internal range starts counting our own infrastructure as user signal, so a vote-ring panel
// reports clusters made of Civitai traffic and nothing anywhere errors.
//
// 🔴 THE RANGE LIST NOW LIVES IN `@civitai/shared/clickhouse-ip-filters`, because the main Next app
// reads the same table and cannot import anything from `apps/moderator`. It is re-exported here so
// this app's existing importers are unchanged; adding a range in the shared module reaches both.
export { INTERNAL_IP_RANGE } from '@civitai/shared/clickhouse-ip-filters';

/** Interpolated into ClickHouse queries, which do NO escaping — every IP must match this first. */
export const IP_PATTERN = /^[0-9a-fA-F.:]{3,45}$/;
