/**
 * Browser-mode `process` shim. MUST be the first setupFile for the `component`
 * project (before `component-setup.tsx`) and have no imports of its own, so it
 * runs before any component's transitive module graph evaluates.
 *
 * Civitai's client modules (e.g. `src/env/other.ts`) read `process.env.NODE_ENV`
 * / `process.env.IS_PREVIEW` at import time. Next replaces those statically at
 * build; the browser test runner does not, so `process` is undefined without
 * this. The Proxy returns `undefined` for any unset key (matching missing env)
 * rather than throwing.
 */
const env = new Proxy(
  { NODE_ENV: 'test' } as Record<string, string | undefined>,
  {
    get(target, prop: string) {
      return prop in target ? target[prop] : undefined;
    },
  }
);

const g = globalThis as unknown as { process?: { env: Record<string, unknown> } };
if (!g.process) {
  g.process = { env };
} else if (!g.process.env) {
  g.process.env = env;
}
