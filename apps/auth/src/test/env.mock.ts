// Test stub for `$env/dynamic/private` — backs the SvelteKit virtual module with process.env, so tests set
// values via process.env (e.g. process.env.AUTH_INTERNAL_TOKEN = ...).
export const env = process.env as Record<string, string | undefined>;
