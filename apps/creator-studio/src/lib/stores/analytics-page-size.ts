import { persisted } from '$lib/stores/persisted';

// Shared rows-per-page preference for the client-paginated analytics tables (models, engagement, base models).
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
export const analyticsPageSize = persisted<number>('analytics-page-size', 25);
