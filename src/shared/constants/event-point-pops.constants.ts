// Which event-point pops a viewer sees: `active`, from their own reactions only; `all`, also when
// anyone else's action raises their own total. Pops only: totals and standings are the same either way.
export const EVENT_POINT_POPS = ['all', 'active'] as const;
export type EventPointPops = (typeof EVENT_POINT_POPS)[number];
export const DEFAULT_EVENT_POINT_POPS: EventPointPops = 'all';
