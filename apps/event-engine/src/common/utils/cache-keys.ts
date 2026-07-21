import { EntityType } from '../types/metric-types';

export const cacheKeys = {
    metric: (entityType: EntityType, id: number) => `metrics:${entityType}:${id}`,
    metricLock: (entityType: EntityType, id: number) => `metrics:lock:${entityType}:${id}`
}