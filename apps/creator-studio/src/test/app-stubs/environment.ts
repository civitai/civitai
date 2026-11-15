// Plain stand-ins for SvelteKit's `$app/*` virtual modules, so a test can mount a component outside SvelteKit.
// Tests override them with `vi.mock`.
export const browser = false;
export const dev = true;
