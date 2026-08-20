// Test stub for `$env/dynamic/private` — backs the SvelteKit virtual module with process.env, the same
// shape apps/auth uses. Modules under test set values via process.env (`$lib/server/db` requires
// DATABASE_URL at import time, so anything reaching it needs one set before the import).
export const env = process.env as Record<string, string | undefined>;
