import { applyApiRequestPolicy } from '~/server/middleware/api-request-policy';

/**
 * Hands the proxy's API policy to the standalone server (`scripts/trpc-server/server.cjs`).
 *
 * That server is plain CommonJS that calls compiled pages-API route modules directly and never runs
 * the proxy (`src/proxy.ts`). Under its `api` profile it serves `/api/v1/` pages, which DO sit
 * behind the proxy under Next, so before their route runs it must do what Next does there. That is
 * two things. The proxy MIDDLEWARES' whole effect on an API request is `applyApiRequestPolicy` (the
 * shared implementation the proxy middlewares and the tRPC route already use;
 * `standalone-api-policy.test.ts` pins that no other middleware acts on an `/api/v1/` request).
 * Next's own machinery around the proxy also caps a non-GET request body at
 * `proxyClientMaxBodySize`; the server reproduces that itself with Next's function
 * (`applyProxyBodyLimit` in `scripts/trpc-server/next-compat.cjs`). It cannot import TypeScript, so instrumentation registers
 * the function here, on `globalThis`, before the server takes its first request; the server reads
 * it at boot and refuses to start under a profile that needs it if it is missing.
 *
 * The key must equal `API_POLICY_GLOBAL_KEY` in `scripts/trpc-server/served-pages.cjs`; the test
 * reads that file to check it.
 */
export const STANDALONE_API_POLICY_KEY = 'civitai.standalone.applyApiRequestPolicy';

export function registerStandaloneApiPolicy() {
  (globalThis as Record<symbol, unknown>)[Symbol.for(STANDALONE_API_POLICY_KEY)] =
    applyApiRequestPolicy;
}
