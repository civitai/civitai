// `$env/dynamic/private` outside SvelteKit: the process environment, which a test can set.
export const env = process.env as Record<string, string | undefined>;
