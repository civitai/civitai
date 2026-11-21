// Distinct route-label values per kind per process: bounds the label cardinality of the 5xx
// counter (prom/http-errors.ts) and the Pyroscope `route` label (pyroscope-labels.ts). Sized to
// the real route surface (~200 wrapped Pages-API route files, ~870 tRPC procedures). Imports
// nothing, so any module can use it.
export const ROUTE_BUDGET = { api: 400, trpc: 1000 } as const;
export type RouteKind = keyof typeof ROUTE_BUDGET;
