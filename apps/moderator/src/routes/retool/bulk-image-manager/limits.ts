// Shared by the load and the page, so the selector cannot offer a size the schema rejects. Separate
// module because `+page.server.ts` is server-only — importing it from the component pulls the DB in.
export const LIMIT_OPTIONS = [200, 500, 1000] as const;
export const DEFAULT_LIMIT = LIMIT_OPTIONS[0];
export const MAX_LIMIT = LIMIT_OPTIONS[LIMIT_OPTIONS.length - 1];
