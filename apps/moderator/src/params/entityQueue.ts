import type { ParamMatcher } from '@sveltejs/kit';
import { entityQueueForSlug } from '$lib/entity-report-queues';

// `/reports/[queue=entityQueue]`: the report types that share the queue layout. A matcher outranks the
// plain `[slug]` table route beside it, so every other type still reaches its table.
export const match = ((param: string) =>
  entityQueueForSlug(param) !== undefined) satisfies ParamMatcher;
